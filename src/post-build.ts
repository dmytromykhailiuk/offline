import { promises as fs } from "node:fs";
import path from "node:path";
import { transform } from "esbuild";
import { compilePattern, createMatcher, walkFiles } from "./glob";
import { buildBootstrapScript, injectIntoHead } from "./inject-template";
import { normalizeDeploymentPath } from "./internal/environment";
import type {
  OfflineConfig,
  OfflineDataGroup,
  OfflineManifestDisplay,
  OfflineManifestIcon,
} from "./types";
import { buildServiceWorkerSource } from "./worker-template";

/** `offline.json` values resolved against the config file's directory. */
export interface ResolvedOfflineConfig {
  /** Absolute path of the build directory. */
  buildDir: string;
  /** Absolute path of the built index.html. */
  indexFile: string;
  /** Normalized to `""` or `"/<path>"`. */
  deploymentPath: string;
  /** Index pathname with a leading slash, relative to the deployment. */
  index: string;
  spaRoutesPaths: string[];
  authHeaderPath: string;
  criticalAssets: string[];
  lazyLoadAssets: string[];
  dataGroups: OfflineDataGroup[];
  name: string;
  shortName: string;
  themeColor: string;
  backgroundColor: string;
  display: OfflineManifestDisplay;
  icons: OfflineManifestIcon[];
}

// The CLI's own outputs — `**.js`-style patterns must never precache them:
// a stale sw-min.js or critical-assets.json inside the cache defeats both.
const GENERATED_FILES = new Set([
  "/sw.js",
  "/sw-min.js",
  "/critical-assets.json",
  "/build-timestamp.txt",
  "/manifest.webmanifest",
]);

const fail = (message: string): never => {
  throw new Error(message);
};

const configError = (field: string, requirement: string): never =>
  fail(`[offline-postbuild] offline.json: "${field}" ${requirement}`);

const validateStringArray = (value: unknown, field: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    configError(field, "must be an array of strings");
  }
  return value as string[];
};

const validateDataGroups = (value: unknown): OfflineDataGroup[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) configError("dataGroups", "must be an array");
  return (value as unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      configError(`dataGroups[${index}]`, "must be an object");
    }
    const group = raw as Record<string, unknown>;
    if (typeof group.name !== "string" || group.name.length === 0) {
      configError(`dataGroups[${index}].name`, "must be a non-empty string");
    }
    const urls = validateStringArray(group.urls, `dataGroups[${index}].urls`);
    const patterns = validateStringArray(group.patterns, `dataGroups[${index}].patterns`);
    if (urls.length === 0 && patterns.length === 0) {
      configError(
        `dataGroups[${index}]`,
        'must have at least one of "urls" or "patterns" non-empty',
      );
    }
    if (
      group.maxSize !== undefined &&
      (typeof group.maxSize !== "number" || !Number.isFinite(group.maxSize) || group.maxSize <= 0)
    ) {
      configError(`dataGroups[${index}].maxSize`, "must be a positive number");
    }
    return {
      name: group.name as string,
      urls,
      patterns,
      ...(group.maxSize !== undefined ? { maxSize: group.maxSize as number } : {}),
    };
  });
};

const MANIFEST_DISPLAYS: readonly OfflineManifestDisplay[] = [
  "standalone",
  "fullscreen",
  "minimal-ui",
  "browser",
];

const validateDisplay = (value: unknown): OfflineManifestDisplay => {
  if (value === undefined) return "standalone";
  if (!MANIFEST_DISPLAYS.includes(value as OfflineManifestDisplay)) {
    configError(
      "display",
      `must be one of ${MANIFEST_DISPLAYS.map((display) => `"${display}"`).join(", ")}`,
    );
  }
  return value as OfflineManifestDisplay;
};

const validateIcons = (value: unknown): OfflineManifestIcon[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) configError("icons", "must be an array");
  return (value as unknown[]).map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      configError(`icons[${index}]`, "must be an object");
    }
    const icon = raw as Record<string, unknown>;
    for (const field of ["src", "sizes"] as const) {
      if (typeof icon[field] !== "string" || (icon[field] as string).length === 0) {
        configError(`icons[${index}].${field}`, "must be a non-empty string");
      }
    }
    for (const field of ["type", "purpose"] as const) {
      if (icon[field] !== undefined && typeof icon[field] !== "string") {
        configError(`icons[${index}].${field}`, "must be a string");
      }
    }
    return {
      src: icon.src as string,
      sizes: icon.sizes as string,
      ...(icon.type !== undefined ? { type: icon.type as string } : {}),
      ...(icon.purpose !== undefined ? { purpose: icon.purpose as string } : {}),
    };
  });
};

const optionalString = (value: unknown, field: string, fallback: string): string => {
  if (value === undefined) return fallback;
  if (typeof value !== "string") configError(field, "must be a string");
  return value as string;
};

const stripLeadingSlash = (value: string): string => value.replace(/^\/+/, "");

const withLeadingSlash = (value: string): string => (value.startsWith("/") ? value : `/${value}`);

/** Read, parse and validate `offline.json`, resolving paths against its directory. */
export const loadOfflineConfig = async (configPath: string): Promise<ResolvedOfflineConfig> => {
  const absoluteConfigPath = path.resolve(configPath);
  let rawText: string;
  try {
    rawText = await fs.readFile(absoluteConfigPath, "utf-8");
  } catch {
    return fail(`[offline-postbuild] cannot read config file at ${absoluteConfigPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    return fail(
      `[offline-postbuild] ${absoluteConfigPath} is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("[offline-postbuild] offline.json must contain a JSON object");
  }
  const config = raw as Record<string, unknown>;
  if (typeof config.buildPath !== "string" || config.buildPath.length === 0) {
    configError("buildPath", "is required and must be a non-empty string");
  }
  if (typeof config.name !== "string" || config.name.length === 0) {
    configError("name", "is required and must be a non-empty string");
  }
  for (const field of ["shortName", "themeColor", "backgroundColor"] as const) {
    if (config[field] !== undefined && typeof config[field] !== "string") {
      configError(field, "must be a string");
    }
  }

  // "/dist" in the config reads absolute but means "next to offline.json" —
  // the leading slash is a convention, not a filesystem root.
  const baseDir = path.dirname(absoluteConfigPath);
  const buildDir = path.resolve(baseDir, stripLeadingSlash(config.buildPath as string));
  const index = withLeadingSlash(optionalString(config.index, "index", "/index.html"));

  return {
    buildDir,
    indexFile: path.join(buildDir, stripLeadingSlash(index)),
    deploymentPath: normalizeDeploymentPath(
      optionalString(config.deploymentPath, "deploymentPath", ""),
    ),
    index,
    // ["page"] is the worker template's own default — an empty prefix would
    // turn every request into a SPA route.
    spaRoutesPaths:
      config.spaRoutesPaths === undefined
        ? ["page"]
        : validateStringArray(config.spaRoutesPaths, "spaRoutesPaths"),
    authHeaderPath: optionalString(config.authHeaderPath, "authHeaderPath", "Authorization"),
    criticalAssets: validateStringArray(config.criticalAssets, "criticalAssets"),
    lazyLoadAssets: validateStringArray(config.lazyLoadAssets, "lazyLoadAssets"),
    dataGroups: validateDataGroups(config.dataGroups),
    name: config.name as string,
    shortName: (config.shortName as string | undefined) ?? (config.name as string),
    themeColor: (config.themeColor as string | undefined) ?? "#ffffff",
    backgroundColor: (config.backgroundColor as string | undefined) ?? "#ffffff",
    display: validateDisplay(config.display),
    icons: validateIcons(config.icons),
  };
};

export const writeBuildTimestamp = async (buildDir: string): Promise<string> => {
  const timestamp = String(Date.now());
  await fs.writeFile(path.join(buildDir, "build-timestamp.txt"), timestamp, "utf-8");
  return timestamp;
};

export interface CollectedAssets {
  /** Deployment-prefixed pathnames of the critical files. */
  critical: string[];
  /** Deployment-prefixed pathnames of the lazy files, minus critical overlap. */
  lazy: string[];
}

/** Match the build directory's files against the config patterns. */
export const collectAssets = async (
  config: Pick<
    ResolvedOfflineConfig,
    "buildDir" | "criticalAssets" | "lazyLoadAssets" | "deploymentPath"
  >,
): Promise<CollectedAssets> => {
  const files = (await walkFiles(config.buildDir)).filter((file) => !GENERATED_FILES.has(file));
  const match = (patterns: string[]): string[] => files.filter(createMatcher(patterns));
  const critical = match(config.criticalAssets).map((file) => config.deploymentPath + file);
  const criticalSet = new Set(critical);
  const lazy = match(config.lazyLoadAssets)
    .map((file) => config.deploymentPath + file)
    .filter((file) => !criticalSet.has(file));
  return { critical, lazy };
};

export const writeCriticalAssetsJson = async (
  buildDir: string,
  critical: string[],
): Promise<void> => {
  await fs.writeFile(
    path.join(buildDir, "critical-assets.json"),
    JSON.stringify(critical, null, 2),
    "utf-8",
  );
};

/**
 * Compile data-group glob patterns — the same language, through the same
 * `compilePattern`, as `criticalAssets` — into RegExp sources the worker can
 * instantiate at startup. The deployment path is baked into each pattern
 * *before* compilation, so the sources match runtime pathnames; a
 * `**`-prefixed pattern needs no prefix — its `.*` consumes any lead-in.
 */
export const compileDataGroupPatterns = (patterns: string[], deploymentPath: string): string[] =>
  patterns.map((pattern) => {
    if (pattern.startsWith("**")) return compilePattern(pattern).source;
    return compilePattern(`${deploymentPath}${withLeadingSlash(pattern)}`).source;
  });

/** Generate, minify (in-memory, no intermediate sw.js) and write `sw-min.js`. */
export const writeServiceWorker = async (
  config: ResolvedOfflineConfig,
  assets: CollectedAssets,
): Promise<void> => {
  const source = buildServiceWorkerSource({
    indexPath: config.index,
    spaRoutesPaths: config.spaRoutesPaths,
    deploymentPath: config.deploymentPath,
    authHeader: config.authHeaderPath,
    dataGroups: config.dataGroups.map((group) => ({
      name: group.name,
      urls: (group.urls ?? []).map((url) => config.deploymentPath + withLeadingSlash(url)),
      patterns: compileDataGroupPatterns(group.patterns ?? [], config.deploymentPath),
      ...(group.maxSize !== undefined ? { maxSize: group.maxSize } : {}),
    })),
    criticalAssets: assets.critical,
    lazyLoadAssets: assets.lazy,
  });
  const minified = await transform(source, { minify: true, loader: "js" });
  await fs.writeFile(path.join(config.buildDir, "sw-min.js"), minified.code, "utf-8");
};

/**
 * Generate `manifest.webmanifest` from the config's flat manifest fields.
 * camelCase config keys map to the spec's snake_case; `scope` and
 * `start_url` derive from `deploymentPath` — the same source of truth the
 * worker and the tracker use.
 */
export const writeWebManifest = async (config: ResolvedOfflineConfig): Promise<void> => {
  const scope = `${config.deploymentPath}/`;
  const webManifest = {
    name: config.name,
    short_name: config.shortName,
    theme_color: config.themeColor,
    background_color: config.backgroundColor,
    display: config.display,
    scope,
    start_url: scope,
    icons: config.icons,
  };
  await fs.writeFile(
    path.join(config.buildDir, "manifest.webmanifest"),
    JSON.stringify(webManifest, null, 2),
    "utf-8",
  );
};

/** Inject (or re-inject) the bootstrap block into the built index.html. */
export const injectIntoIndexHtml = async (config: ResolvedOfflineConfig): Promise<void> => {
  let html: string;
  try {
    html = await fs.readFile(config.indexFile, "utf-8");
  } catch {
    return fail(`[offline-postbuild] cannot read the built index at ${config.indexFile}`);
  }
  const injected = injectIntoHead(html, buildBootstrapScript(config.deploymentPath));
  await fs.writeFile(config.indexFile, injected, "utf-8");
};

export interface RunPostBuildOptions {
  configPath?: string;
  /** Progress sink; defaults to silent so programmatic use stays quiet. */
  log?: (message: string) => void;
}

/** The whole pipeline, in order. Throws with a contextual message on any failure. */
export const runPostBuild = async ({
  configPath = "./offline.json",
  log = () => {},
}: RunPostBuildOptions = {}): Promise<ResolvedOfflineConfig> => {
  const config = await loadOfflineConfig(configPath);
  log(`✔ offline.json loaded (${config.buildDir})`);
  await writeBuildTimestamp(config.buildDir);
  log("✔ build-timestamp.txt generated");
  const assets = await collectAssets(config);
  log(`✔ assets collected (${assets.critical.length} critical, ${assets.lazy.length} lazy)`);
  await writeCriticalAssetsJson(config.buildDir, assets.critical);
  log("✔ critical-assets.json generated");
  await writeWebManifest(config);
  log("✔ manifest.webmanifest generated");
  await writeServiceWorker(config, assets);
  log("✔ sw-min.js generated");
  await injectIntoIndexHtml(config);
  log(`✔ bootstrap injected into ${path.basename(config.indexFile)}`);
  return config;
};
