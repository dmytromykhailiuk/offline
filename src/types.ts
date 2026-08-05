/**
 * Options for {@link OfflineTracker.init}. Every field is optional — the
 * defaults reproduce the conventions of the `offline-postbuild` CLI.
 */
export interface OfflineTrackerOptions {
  /**
   * Turn the whole tracker into an inert no-op. The offline layer only
   * exists in a real build (`offline-postbuild` generates the worker and the
   * manifest), so pass your dev flag here — e.g.
   * `disabled: import.meta.env.DEV`. While disabled nothing runs:
   * no `critical-assets.json` fetch, no listeners,
   * {@link OfflineTracker.registerServiceWorker} skips registration,
   * {@link OfflineTracker.stabilizeCaching} resolves without doing anything,
   * repeated `init()` calls stay no-ops, and
   * {@link OfflineTracker.isOfflineReady} stays `false`.
   * Default: `false`.
   */
  disabled?: boolean;
  /**
   * Called before every request the tracker makes — the assets list, cache
   * probes and cache-warming loads — with a `Headers` instance holding what
   * is about to be sent; returns the `Headers` to actually send (mutating
   * and returning the same instance is fine). Attach an auth token here.
   * The analog of {@link OfflineTrackerOptions.mapAssetUrl}, for headers.
   * Default: identity.
   */
  modifyRequestHeaders?: (headers: Headers) => Headers;
  /**
   * Transforms every asset URL (from `critical-assets.json` and the
   * `additional*` lists) before it is requested — e.g. to substitute a
   * theme or translation version into the path. Must keep the pathname
   * identical to what the service worker has in its generated lists,
   * otherwise the asset is never cached. Default: identity.
   */
  mapAssetUrl?: (url: string) => string;
  /**
   * Consulted before an automatic {@link OfflineTracker.stabilizeCaching}
   * run after the connection comes back. Return `false` to skip it — e.g.
   * while the user is on an upload screen. Default: `() => true`.
   */
  shouldStabilize?: () => boolean;
  /**
   * Milliseconds to wait after `navigator.serviceWorker.ready` before
   * loading assets, giving a fresh worker time to take over the page.
   * Default: 1000.
   */
  swSettleDelay?: number;
  /** Milliseconds between cache re-check rounds while loading. Default: 2500. */
  retryDelay?: number;
  /**
   * Milliseconds to wait after the connection comes back before resuming
   * a loading loop. Default: 250.
   */
  reconnectSettleDelay?: number;
  /**
   * Extra assets that must be cached — on top of `critical-assets.json` —
   * before the app counts as ready to work offline. Later
   * {@link OfflineTracker.reInit} calls **merge** into this: every cycle
   * tracks the deduplicated union of everything passed so far, until
   * {@link OfflineTracker.destroy}.
   */
  additionalCriticalAssets?: string[];
  /**
   * Extra assets loaded in the background. They gate
   * {@link OfflineTracker.isOfflineReady} but load without blocking the
   * critical set. Merged across {@link OfflineTracker.reInit} calls, like
   * the critical ones.
   */
  additionalLazyLoadAssets?: string[];
}

/**
 * Options for {@link OfflineTracker.reInit} — only the asset lists. The
 * configuration (hooks, delays, `disabled`) is fixed by
 * {@link OfflineTracker.init}; use {@link OfflineTracker.destroy} to change
 * it.
 */
export interface OfflineTrackerReInitOptions {
  /** Merged (deduplicated) with everything passed to init() and earlier reInit() calls. */
  additionalCriticalAssets?: string[];
  /** Merged (deduplicated) with everything passed to init() and earlier reInit() calls. */
  additionalLazyLoadAssets?: string[];
}

/** Snapshot returned by {@link OfflineTracker.status}. */
export interface OfflineStatus {
  /** Every critical asset (built list + additional) is in the cache. */
  criticalAssetsLoaded: boolean;
  /** Every additional lazy-load asset is in the cache. */
  lazyAssetsLoaded: boolean;
  /** Both of the above — the value behind {@link OfflineTracker.isOfflineReady}. */
  allAssetsLoaded: boolean;
}

/**
 * Called on every change of {@link OfflineTracker.isOfflineReady}, with the
 * new value. See {@link OfflineTracker.subscribe}.
 */
export type OfflineTrackerListener = (isOfflineReady: boolean) => void;

/** Detaches a listener registered with {@link OfflineTracker.subscribe}. */
export type OfflineTrackerUnsubscribe = () => void;

/**
 * The global that `offline-postbuild` injects into `index.html`. The runtime
 * reads it as the build-time source of truth for the deployment path.
 */
export interface OfflineGlobalConfig {
  deploymentPath?: string;
}

declare global {
  interface Window {
    __OFFLINE_CONFIG__?: OfflineGlobalConfig;
  }
}

/**
 * A named cache for runtime data requests, matched by URL prefix and/or
 * glob pattern. Part of `offline.json` (see {@link OfflineConfig}).
 * A request belongs to the group when its pathname starts with any of
 * `urls` **or** matches any of `patterns`.
 */
export interface OfflineDataGroup {
  /** Cache name suffix — the group is stored as `data-group-<name>`. */
  name: string;
  /**
   * URL pathname prefixes served cache-first from this group. At least one
   * of `urls` / `patterns` must be non-empty.
   */
  urls?: string[];
  /**
   * Glob patterns matched against the request pathname — the same language
   * as `criticalAssets`: `**` across segments, `*` within one segment,
   * `?` a single character, anything else an exact path. `deploymentPath`
   * is applied at generation time, so write them deployment-agnostic. At
   * least one of `urls` / `patterns` must be non-empty.
   */
  patterns?: string[];
  /** Maximum number of entries kept in the group; oldest evicted first. */
  maxSize?: number;
}

/** One icon entry of the generated web app manifest. */
export interface OfflineManifestIcon {
  /** Icon path, resolved by the browser relative to the manifest file. */
  src: string;
  /** e.g. `"192x192"`. */
  sizes: string;
  /** e.g. `"image/png"`. */
  type?: string;
  /** e.g. `"maskable any"`. */
  purpose?: string;
}

/**
 * How the installed app is displayed — the manifest spec's `display` member:
 *
 * - `"standalone"` — its own window, no browser UI. The PWA default.
 * - `"fullscreen"` — the whole screen, even the status bar is hidden.
 * - `"minimal-ui"` — own window plus a minimal set of navigation controls.
 * - `"browser"` — a regular browser tab; effectively opts out of the
 *   app-like experience.
 */
export type OfflineManifestDisplay = "standalone" | "fullscreen" | "minimal-ui" | "browser";

/**
 * Shape of `offline.json` — the configuration file of the
 * `offline-postbuild` CLI. All paths are resolved relative to the directory
 * containing the config file; a leading `/` is allowed and ignored.
 *
 * Every run also generates `manifest.webmanifest` from the flat manifest
 * fields below (`name`, `shortName`, `themeColor`, `backgroundColor`,
 * `display`, `icons`) and links it from `index.html`. The manifest's
 * `scope`/`start_url` are never configured — both derive from
 * `deploymentPath` (`` `${deploymentPath}/` ``), the same single source of
 * truth the worker and the tracker use.
 */
export interface OfflineConfig {
  /** The app's name — shown at install time, `name` of the manifest. Required. */
  name: string;
  /** `short_name` of the manifest — the homescreen label. Default: `name`. */
  shortName?: string;
  /** `theme_color` of the manifest. Default: `"#ffffff"`. */
  themeColor?: string;
  /** `background_color` of the manifest. Default: `"#ffffff"`. */
  backgroundColor?: string;
  /** Display mode of the installed app. Default: `"standalone"`. */
  display?: OfflineManifestDisplay;
  /** Manifest icons, passed through verbatim. Default: `[]`. */
  icons?: OfflineManifestIcon[];
  /** Directory of the built app, e.g. `"/dist"`. Required. */
  buildPath: string;
  /** Path prefix the app is deployed under, e.g. `"/client"`. Default: `""`. */
  deploymentPath?: string;
  /** The built HTML entry inside `buildPath`. Default: `"/index.html"`. */
  index?: string;
  /** Pathname prefixes of SPA routes served with the cached index. Default: `["page"]`. */
  spaRoutesPaths?: string[];
  /** Request header the service worker forwards as auth. Default: `"Authorization"`. */
  authHeaderPath?: string;
  /**
   * Patterns of files that must be cached for offline readiness —
   * Angular-PWA-style globs: `**` across segments, `*` within a segment,
   * `?` a single character, a `!` prefix excludes (a file must match at
   * least one plain pattern and no `!` pattern); anything else is an exact
   * path. Default: `[]`.
   */
  criticalAssets?: string[];
  /** Patterns of files cached in the background; same glob language. Default: `[]`. */
  lazyLoadAssets?: string[];
  /** Named runtime caches for data requests. Default: `[]`. */
  dataGroups?: OfflineDataGroup[];
}
