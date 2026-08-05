// @vitest-environment node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectAssets,
  compileDataGroupPatterns,
  loadOfflineConfig,
  runPostBuild,
} from "../src/post-build";

let projectDir: string;

const writeConfig = async (config: unknown): Promise<string> => {
  const configPath = path.join(projectDir, "offline.json");
  await fs.writeFile(configPath, JSON.stringify(config), "utf-8");
  return configPath;
};

const makeFixtureBuild = async (): Promise<void> => {
  const dist = path.join(projectDir, "dist");
  await fs.mkdir(path.join(dist, "assets"), { recursive: true });
  await fs.mkdir(path.join(dist, "images"), { recursive: true });
  await fs.writeFile(
    path.join(dist, "index.html"),
    "<html><head><title>x</title></head><body></body></html>",
  );
  await fs.writeFile(path.join(dist, "main.js"), "console.log(1)");
  await fs.writeFile(path.join(dist, "assets", "chunk.js"), "console.log(2)");
  await fs.writeFile(path.join(dist, "styles.css"), "body{}");
  await fs.writeFile(path.join(dist, "images", "logo.png"), "png");
  await fs.writeFile(path.join(dist, "images", "photo.jpg"), "jpg");
};

const FIXTURE_CONFIG = {
  buildPath: "/dist",
  deploymentPath: "/client",
  index: "/index.html",
  spaRoutesPaths: ["/page", "/settings"],
  authHeaderPath: "X-Auth",
  criticalAssets: ["**.js", "**.css", "/images/logo.png"],
  lazyLoadAssets: ["/images/*.jpg"],
  dataGroups: [
    { name: "themes", urls: ["/themes/"], maxSize: 2 },
    { name: "silhouettes", patterns: ["**/silhouettes/**.png"] },
  ],
  name: "Client",
  themeColor: "#1c1c1c",
  icons: [
    {
      src: "core-assets/icons/icon-192x192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "maskable any",
    },
  ],
};

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "offline-cli-"));
});

afterEach(async () => {
  await fs.rm(projectDir, { recursive: true, force: true });
});

describe("loadOfflineConfig()", () => {
  it("fails with a clear message when the file is missing", async () => {
    await expect(loadOfflineConfig(path.join(projectDir, "offline.json"))).rejects.toThrow(
      /cannot read config file at/,
    );
  });

  it("fails on invalid JSON", async () => {
    const configPath = path.join(projectDir, "offline.json");
    await fs.writeFile(configPath, "{ nope", "utf-8");
    await expect(loadOfflineConfig(configPath)).rejects.toThrow(/is not valid JSON/);
  });

  it("requires buildPath", async () => {
    const configPath = await writeConfig({ name: "App" });
    await expect(loadOfflineConfig(configPath)).rejects.toThrow(
      '[offline-postbuild] offline.json: "buildPath" is required and must be a non-empty string',
    );
  });

  it("requires name — the manifest is always generated", async () => {
    const configPath = await writeConfig({ buildPath: "/dist" });
    await expect(loadOfflineConfig(configPath)).rejects.toThrow(
      '[offline-postbuild] offline.json: "name" is required and must be a non-empty string',
    );
  });

  it("validates field shapes with specific messages", async () => {
    const bad = async (config: unknown, message: string) => {
      await expect(loadOfflineConfig(await writeConfig(config))).rejects.toThrow(message);
    };
    await bad(
      { buildPath: "/dist", name: "App", criticalAssets: [42] },
      '"criticalAssets" must be an array of strings',
    );
    await bad(
      { buildPath: "/dist", name: "App", spaRoutesPaths: "/page" },
      '"spaRoutesPaths" must be an array of strings',
    );
    await bad(
      { buildPath: "/dist", name: "App", dataGroups: [{ name: "" }] },
      '"dataGroups[0].name" must be a non-empty string',
    );
    await bad(
      { buildPath: "/dist", name: "App", dataGroups: [{ name: "x", urls: [] }] },
      '"dataGroups[0]" must have at least one of "urls" or "patterns" non-empty',
    );
    await bad(
      { buildPath: "/dist", name: "App", dataGroups: [{ name: "x", patterns: "**.png" }] },
      '"dataGroups[0].patterns" must be an array of strings',
    );
    await bad(
      { buildPath: "/dist", name: "App", dataGroups: [{ name: "x", urls: ["/y/"], maxSize: -1 }] },
      '"dataGroups[0].maxSize" must be a positive number',
    );
  });

  it("validates the manifest fields with specific messages", async () => {
    const bad = async (extra: object, message: string) => {
      await expect(
        loadOfflineConfig(await writeConfig({ buildPath: "/dist", name: "App", ...extra })),
      ).rejects.toThrow(message);
    };
    await bad({ themeColor: 7 }, '"themeColor" must be a string');
    await bad(
      { display: "popup" },
      '"display" must be one of "standalone", "fullscreen", "minimal-ui", "browser"',
    );
    await bad({ icons: {} }, '"icons" must be an array');
    await bad({ icons: [{ sizes: "72x72" }] }, '"icons[0].src" must be a non-empty string');
    await bad(
      { icons: [{ src: "a.png", sizes: "72x72", purpose: 1 }] },
      '"icons[0].purpose" must be a string',
    );
  });

  it("resolves paths relative to the config file and applies defaults", async () => {
    const configPath = await writeConfig({ buildPath: "/dist", name: "App" });
    const config = await loadOfflineConfig(configPath);
    expect(config.buildDir).toBe(path.join(projectDir, "dist"));
    expect(config.indexFile).toBe(path.join(projectDir, "dist", "index.html"));
    expect(config.deploymentPath).toBe("");
    expect(config.spaRoutesPaths).toEqual(["page"]);
    expect(config.authHeaderPath).toBe("Authorization");
    expect(config.shortName).toBe("App");
    expect(config.themeColor).toBe("#ffffff");
    expect(config.backgroundColor).toBe("#ffffff");
    expect(config.display).toBe("standalone");
    expect(config.icons).toEqual([]);
  });

  it("accepts a data group with only patterns, or both lists at once", async () => {
    const config = await loadOfflineConfig(
      await writeConfig({
        buildPath: "/dist",
        name: "App",
        dataGroups: [
          { name: "images", patterns: ["**.webp"] },
          { name: "mixed", urls: ["/themes/"], patterns: ["**/fonts/**.woff2"] },
        ],
      }),
    );
    expect(config.dataGroups).toEqual([
      { name: "images", urls: [], patterns: ["**.webp"] },
      { name: "mixed", urls: ["/themes/"], patterns: ["**/fonts/**.woff2"] },
    ]);
  });

  it("normalizes the deploymentPath", async () => {
    const configPath = await writeConfig({
      buildPath: "/dist",
      name: "App",
      deploymentPath: "web/",
    });
    const config = await loadOfflineConfig(configPath);
    expect(config.deploymentPath).toBe("/web");
  });
});

describe("compileDataGroupPatterns()", () => {
  const matchesAny = (sources: string[], pathname: string): boolean =>
    sources.some((source) => new RegExp(source).test(pathname));

  it("bakes the deployment path in before compiling", () => {
    const sources = compileDataGroupPatterns(["/themes/**.css", "fonts/*.woff2"], "/client");
    expect(matchesAny(sources, "/client/themes/dark/a.css")).toBe(true);
    expect(matchesAny(sources, "/client/fonts/inter.woff2")).toBe(true);
    expect(matchesAny(sources, "/other/themes/a.css")).toBe(false);
    expect(matchesAny(sources, "/themes/a.css")).toBe(false);
  });

  it("leaves **-prefixed patterns unprefixed — they already match any depth", () => {
    const sources = compileDataGroupPatterns(["**.webp"], "/client");
    expect(matchesAny(sources, "/client/nested/photo.webp")).toBe(true);
    expect(matchesAny(sources, "/photo.webp")).toBe(true);
    expect(matchesAny(sources, "/photo.png")).toBe(false);
  });

  it("compiles as-is for a root deployment", () => {
    const sources = compileDataGroupPatterns(["/themes/**.css"], "");
    expect(matchesAny(sources, "/themes/a.css")).toBe(true);
    expect(matchesAny(sources, "/other/a.css")).toBe(false);
  });
});

describe("collectAssets()", () => {
  it("matches patterns, prefixes deploymentPath and skips generated files", async () => {
    await makeFixtureBuild();
    const dist = path.join(projectDir, "dist");
    // Leftovers from a previous run must not be re-collected as assets.
    await fs.writeFile(path.join(dist, "sw-min.js"), "");
    await fs.writeFile(path.join(dist, "critical-assets.json"), "[]");
    await fs.writeFile(path.join(dist, "build-timestamp.txt"), "1");
    const config = await loadOfflineConfig(await writeConfig(FIXTURE_CONFIG));
    const assets = await collectAssets(config);
    expect(assets.critical).toEqual([
      "/client/assets/chunk.js",
      "/client/images/logo.png",
      "/client/main.js",
      "/client/styles.css",
    ]);
    expect(assets.lazy).toEqual(["/client/images/photo.jpg"]);
  });

  it("supports ? wildcards and ! negation in the patterns", async () => {
    await makeFixtureBuild();
    const config = await loadOfflineConfig(
      await writeConfig({
        ...FIXTURE_CONFIG,
        criticalAssets: ["**.js", "!assets/**.js", "images/photo.jp?"],
        lazyLoadAssets: [],
      }),
    );
    const assets = await collectAssets(config);
    expect(assets.critical).toEqual(["/client/images/photo.jpg", "/client/main.js"]);
  });

  it("drops lazy entries already covered by critical patterns", async () => {
    await makeFixtureBuild();
    const config = await loadOfflineConfig(
      await writeConfig({ ...FIXTURE_CONFIG, lazyLoadAssets: ["**.js", "/images/*.jpg"] }),
    );
    const assets = await collectAssets(config);
    expect(assets.lazy).toEqual(["/client/images/photo.jpg"]);
  });
});

describe("runPostBuild()", () => {
  it("produces every artifact of the pipeline", async () => {
    await makeFixtureBuild();
    const configPath = await writeConfig(FIXTURE_CONFIG);
    const logs: string[] = [];
    await runPostBuild({ configPath, log: (message) => logs.push(message) });
    const dist = path.join(projectDir, "dist");

    const timestamp = await fs.readFile(path.join(dist, "build-timestamp.txt"), "utf-8");
    expect(Number(timestamp)).toBeGreaterThan(0);

    const critical = JSON.parse(
      await fs.readFile(path.join(dist, "critical-assets.json"), "utf-8"),
    );
    expect(critical).toContain("/client/main.js");
    expect(critical).toContain("/client/images/logo.png");

    const sw = await fs.readFile(path.join(dist, "sw-min.js"), "utf-8");
    expect(sw).not.toContain("__OFFLINE_");
    expect(sw).toContain("/client/main.js");
    expect(sw).toContain("X-Auth");
    // dataGroups urls get the deployment prefix at generation time; glob
    // patterns arrive as build-time-compiled regex sources.
    expect(sw).toContain("/client/themes/");
    expect(sw).toContain("silhouettes");
    // No unminified intermediate left behind.
    await expect(fs.access(path.join(dist, "sw.js"))).rejects.toThrow();

    const manifest = JSON.parse(
      await fs.readFile(path.join(dist, "manifest.webmanifest"), "utf-8"),
    );
    expect(manifest).toEqual({
      name: "Client",
      short_name: "Client",
      theme_color: "#1c1c1c",
      background_color: "#ffffff",
      display: "standalone",
      scope: "/client/",
      start_url: "/client/",
      icons: [
        {
          src: "core-assets/icons/icon-192x192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "maskable any",
        },
      ],
    });

    const html = await fs.readFile(path.join(dist, "index.html"), "utf-8");
    expect(html).toContain("<!-- offline-postbuild:start -->");
    expect(html).toContain('window.__OFFLINE_CONFIG__ = {"deploymentPath":"/client"}');
    expect(html).toContain('<link rel="manifest" href="/client/manifest.webmanifest" />');
    expect(html).toContain("build-timestamp.txt");
    // Injected as the first thing inside <head>, before existing tags.
    expect(html.indexOf("offline-postbuild:start")).toBeLessThan(html.indexOf("<title>"));

    expect(logs.some((line) => line.includes("sw-min.js"))).toBe(true);
    expect(logs.some((line) => line.includes("manifest.webmanifest"))).toBe(true);
  });

  it("derives root scope and manifest defaults from a minimal config", async () => {
    await makeFixtureBuild();
    await runPostBuild({
      configPath: await writeConfig({ buildPath: "/dist", name: "App" }),
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(projectDir, "dist", "manifest.webmanifest"), "utf-8"),
    );
    expect(manifest).toEqual({
      name: "App",
      short_name: "App",
      theme_color: "#ffffff",
      background_color: "#ffffff",
      display: "standalone",
      scope: "/",
      start_url: "/",
      icons: [],
    });
    const html = await fs.readFile(path.join(projectDir, "dist", "index.html"), "utf-8");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  it("generates a syntactically valid worker", async () => {
    await makeFixtureBuild();
    await runPostBuild({ configPath: await writeConfig(FIXTURE_CONFIG) });
    const sw = await fs.readFile(path.join(projectDir, "dist", "sw-min.js"), "utf-8");
    expect(() => new Function(sw)).not.toThrow();
  });

  it("is idempotent — a second run replaces the injected block", async () => {
    await makeFixtureBuild();
    const configPath = await writeConfig(FIXTURE_CONFIG);
    await runPostBuild({ configPath });
    const firstHtml = await fs.readFile(path.join(projectDir, "dist", "index.html"), "utf-8");
    await runPostBuild({ configPath });
    const secondHtml = await fs.readFile(path.join(projectDir, "dist", "index.html"), "utf-8");
    expect(secondHtml).toBe(firstHtml);
    expect(secondHtml.match(/offline-postbuild:start/g)).toHaveLength(1);
  });

  it("fails clearly when the built index.html is missing", async () => {
    await makeFixtureBuild();
    await fs.rm(path.join(projectDir, "dist", "index.html"));
    await expect(runPostBuild({ configPath: await writeConfig(FIXTURE_CONFIG) })).rejects.toThrow(
      /cannot read the built index at/,
    );
  });

  it("fails clearly when index.html has no <head>", async () => {
    await makeFixtureBuild();
    await fs.writeFile(path.join(projectDir, "dist", "index.html"), "<html><body></body></html>");
    await expect(runPostBuild({ configPath: await writeConfig(FIXTURE_CONFIG) })).rejects.toThrow(
      "[offline-postbuild] the built index.html has no <head> to inject into",
    );
  });
});
