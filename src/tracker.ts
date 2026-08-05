import { cacheFirst } from "@dmytromykhailiuk/cache-request";
import { NetworkConnection } from "@dmytromykhailiuk/network-connection";
import { checkAssets, loadAssets } from "./internal/assets";
import { deleteAllCaches } from "./internal/caches";
import {
  delay,
  hasServiceWorker,
  hasWindow,
  normalizeDeploymentPath,
  readOfflineGlobalConfig,
} from "./internal/environment";
import { isNetworkConnectionInitialized, isNetworkOnline } from "./internal/network";
import type {
  OfflineStatus,
  OfflineTrackerListener,
  OfflineTrackerOptions,
  OfflineTrackerReInitOptions,
  OfflineTrackerUnsubscribe,
} from "./types";

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Subscription {
  listener: OfflineTrackerListener;
  /** Flipped by unsubscribe so a listener dropped mid-dispatch is skipped. */
  active: boolean;
}

interface ResolvedOptions {
  disabled: boolean;
  deploymentPath: string;
  criticalAssetsUrl: string;
  fetchFn: typeof fetch;
  mapAssetUrl: (url: string) => string;
  shouldStabilize: () => boolean;
  swSettleDelay: number;
  retryDelay: number;
  reconnectSettleDelay: number;
}

const DEFAULT_SW_SETTLE_DELAY = 1000;
const DEFAULT_RETRY_DELAY = 2500;
const DEFAULT_RECONNECT_SETTLE_DELAY = 250;

// Client-side cache-first bucket for critical-assets.json. The generated
// worker has no branch for the list, so this cache is what lets a repeat
// visit that starts offline initialize at all. Invalidation is external:
// the injected bootstrap wipes every cache when build-timestamp.txt reveals
// a new build, so the next fetch is a fresh one.
const CRITICAL_ASSETS_CACHE_NAME = "offline-critical-assets";

const assertPositiveNumber = (value: number | undefined, name: string): void => {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`[offline] "${name}" must be a positive finite number`);
  }
};

const assertFunction = (value: unknown, name: string): void => {
  if (value === undefined) return;
  if (typeof value !== "function") {
    throw new Error(`[offline] "${name}" must be a function`);
  }
};

const assertStringArray = (value: string[] | undefined, name: string): void => {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`[offline] "${name}" must be an array of strings`);
  }
};

const assertBoolean = (value: unknown, name: string): void => {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new Error(`[offline] "${name}" must be a boolean`);
  }
};

const mergeUnique = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];

/**
 * Tracks whether the app has everything cached to work fully offline.
 *
 * The counterpart of the `offline-postbuild` CLI: the CLI generates the
 * service worker and `critical-assets.json`; this class registers the worker,
 * warms the cache and reports readiness — as a boolean, a subscription and a
 * promise.
 *
 * Requires `NetworkConnection.init()` (from
 * `@dmytromykhailiuk/network-connection`) to have been called first —
 * {@link init} fails fast otherwise and never initializes it on its own.
 */
export class OfflineTracker {
  private static initialized = false;
  private static opts: ResolvedOptions | null = null;

  private static criticalList: string[] = [];
  private static listFetched: Promise<void> | null = null;

  private static criticalLoaded = false;
  private static lazyLoaded = false;
  private static ready = false;
  private static readonly notCachedCritical = new Set<string>();
  private static readonly notCachedLazy = new Set<string>();

  // Bumped by every track() call and by destroy(). A loading loop carries the
  // epoch it started under; once superseded it stops writing state and
  // resolves silently — a superseded cycle is not an error.
  private static epoch = 0;
  // Bumped only by destroy(). The critical-assets.json fetch loop lives on
  // this — a new track() must not kill it, only a teardown may.
  private static generation = 0;
  private static lastAdditional: {
    additionalCriticalAssets: string[];
    additionalLazyLoadAssets: string[];
  } | null = null;

  private static subscriptions: Subscription[] = [];
  private static readyWaiters: Waiter[] = [];

  private static controllerChangeHandler: (() => void) | null = null;
  private static unsubscribeNetwork: (() => void) | null = null;

  private constructor() {
    // `private` stops TypeScript; the throw stops plain JavaScript.
    throw new Error("[offline] OfflineTracker is not constructable — use its static members");
  }

  /**
   * Current readiness snapshot. Throws before {@link init} — a default would
   * be a plausible-looking lie about the cache.
   */
  static get status(): OfflineStatus {
    OfflineTracker.assertInitialized("status");
    return {
      criticalAssetsLoaded: OfflineTracker.criticalLoaded,
      lazyAssetsLoaded: OfflineTracker.lazyLoaded,
      allAssetsLoaded: OfflineTracker.ready,
    };
  }

  /**
   * Whether everything — critical and lazy — is cached and the app can work
   * offline. Shortcut for `status.allAssetsLoaded`. Throws before {@link init}.
   */
  static get isOfflineReady(): boolean {
    OfflineTracker.assertInitialized("isOfflineReady");
    return OfflineTracker.ready;
  }

  /**
   * Verify the `NetworkConnection` precondition, resolve options, wire the
   * `controllerchange` re-track and the reconnect auto-stabilization, then
   * fetch `critical-assets.json` (retried until an ok response arrives;
   * waits for the connection when offline).
   *
   * Synchronous and returns nothing — it kicks the whole process off and
   * the async work (list fetch, cache warming) runs in the background.
   * Follow the progress through {@link status}, {@link isOfflineReady},
   * {@link subscribe} and {@link whenOfflineReady}.
   *
   * Callable **once**: the configuration it resolves is final. Throws on a
   * second call — restart tracking with {@link reInit}, reconfigure via
   * {@link destroy} + `init()`.
   *
   * With `disabled: true` (dev environments — pass your dev flag, e.g.
   * `import.meta.env.DEV`) nothing runs: the tracker initializes inert,
   * every member is a no-op and {@link isOfflineReady} stays `false`. The
   * `NetworkConnection` precondition is skipped too.
   */
  static init(options: OfflineTrackerOptions = {}): void {
    if (OfflineTracker.initialized) {
      throw new Error(
        "[offline] already initialized — call reInit() to restart tracking, or destroy() to reconfigure",
      );
    }
    assertBoolean(options.disabled, "disabled");
    assertFunction(options.modifyRequestHeaders, "modifyRequestHeaders");
    assertFunction(options.mapAssetUrl, "mapAssetUrl");
    assertFunction(options.shouldStabilize, "shouldStabilize");
    assertPositiveNumber(options.swSettleDelay, "swSettleDelay");
    assertPositiveNumber(options.retryDelay, "retryDelay");
    assertPositiveNumber(options.reconnectSettleDelay, "reconnectSettleDelay");
    assertStringArray(options.additionalCriticalAssets, "additionalCriticalAssets");
    assertStringArray(options.additionalLazyLoadAssets, "additionalLazyLoadAssets");

    // The disabled path skips even the NetworkConnection precondition — a dev
    // environment has no offline layer to track and may not have a
    // healthcheck either. The tracker stays readable and inert: all-false
    // status, no requests, no listeners.
    if (options.disabled === true) {
      OfflineTracker.opts = {
        disabled: true,
        deploymentPath: "",
        criticalAssetsUrl: "",
        fetchFn: () => Promise.reject(new Error("[offline] disabled")),
        mapAssetUrl: (url) => url,
        shouldStabilize: () => false,
        swSettleDelay: DEFAULT_SW_SETTLE_DELAY,
        retryDelay: DEFAULT_RETRY_DELAY,
        reconnectSettleDelay: DEFAULT_RECONNECT_SETTLE_DELAY,
      };
      OfflineTracker.listFetched = Promise.resolve();
      OfflineTracker.initialized = true;
      return;
    }

    if (!isNetworkConnectionInitialized()) {
      throw new Error(
        "[offline] NetworkConnection.init() must be called before OfflineTracker.init()",
      );
    }

    // The deployment path has one source of truth: the global the CLI
    // injected into index.html at build time.
    const deploymentPath = normalizeDeploymentPath(readOfflineGlobalConfig()?.deploymentPath ?? "");
    const origin = hasWindow() ? window.location.origin : "";
    const modifyRequestHeaders = options.modifyRequestHeaders ?? ((headers) => headers);
    OfflineTracker.opts = {
      disabled: false,
      deploymentPath,
      criticalAssetsUrl: `${origin}${deploymentPath}/critical-assets.json`,
      // Every request the tracker makes funnels through here, so the headers
      // hook sees each of them — the list, the probes, the loads.
      fetchFn: (input, init = {}) =>
        fetch(input, {
          ...init,
          headers: modifyRequestHeaders(new Headers(init.headers)),
        }),
      mapAssetUrl: options.mapAssetUrl ?? ((url) => url),
      shouldStabilize: options.shouldStabilize ?? (() => true),
      swSettleDelay: options.swSettleDelay ?? DEFAULT_SW_SETTLE_DELAY,
      retryDelay: options.retryDelay ?? DEFAULT_RETRY_DELAY,
      reconnectSettleDelay: options.reconnectSettleDelay ?? DEFAULT_RECONNECT_SETTLE_DELAY,
    };
    OfflineTracker.initialized = true;
    OfflineTracker.lastAdditional = {
      additionalCriticalAssets: options.additionalCriticalAssets ?? [],
      additionalLazyLoadAssets: options.additionalLazyLoadAssets ?? [],
    };
    const myGeneration = OfflineTracker.generation;

    if (hasServiceWorker()) {
      // Every controller change re-runs tracking from scratch with the last
      // additional assets — a new worker means a new, empty cache.
      OfflineTracker.controllerChangeHandler = () => {
        void OfflineTracker.startTracking();
      };
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        OfflineTracker.controllerChangeHandler,
      );
    }

    // subscribe() over an afterOnlineBack() loop: it only fires on changes —
    // so `true` here *is* the offline → online edge — and its unsubscribe
    // gives destroy() a deterministic teardown with no dangling waiter.
    OfflineTracker.unsubscribeNetwork = NetworkConnection.subscribe((isOnline) => {
      if (!isOnline || OfflineTracker.ready) return;
      if (!OfflineTracker.opts || !OfflineTracker.opts.shouldStabilize()) return;
      OfflineTracker.stabilizeCaching().catch((error) => {
        console.error("[offline] automatic stabilizeCaching() failed", error);
      });
    });

    OfflineTracker.listFetched = OfflineTracker.fetchCriticalList(myGeneration);
    void OfflineTracker.startTracking();
  }

  /**
   * Restart tracking with more assets. The passed lists are **merged**
   * (deduplicated) with everything given to {@link init} and to earlier
   * `reInit()` calls — a later caller can never drop what an earlier one
   * declared critical; the union always includes `critical-assets.json`.
   * The configuration is untouched and the list is not refetched.
   * Synchronous, like {@link init}.
   *
   * Throws before {@link init}; a no-op when initialized with
   * `disabled: true`.
   */
  static reInit(options: OfflineTrackerReInitOptions = {}): void {
    OfflineTracker.assertInitialized("reInit()");
    assertStringArray(options.additionalCriticalAssets, "additionalCriticalAssets");
    assertStringArray(options.additionalLazyLoadAssets, "additionalLazyLoadAssets");
    const opts = OfflineTracker.opts as ResolvedOptions;
    if (opts.disabled) return;
    const previous = OfflineTracker.lastAdditional ?? {
      additionalCriticalAssets: [],
      additionalLazyLoadAssets: [],
    };
    OfflineTracker.lastAdditional = {
      additionalCriticalAssets: mergeUnique(
        previous.additionalCriticalAssets,
        options.additionalCriticalAssets ?? [],
      ),
      additionalLazyLoadAssets: mergeUnique(
        previous.additionalLazyLoadAssets,
        options.additionalLazyLoadAssets ?? [],
      ),
    };
    void OfflineTracker.startTracking();
  }

  /**
   * Register the generated worker — `${deploymentPath}/sw-min.js`, with
   * `deploymentPath` taken from the `window.__OFFLINE_CONFIG__` global that
   * `offline-postbuild` injects (or from {@link init} options once
   * initialized). Independent of {@link init}: callable at any moment, in
   * any order. Registered with `updateViaCache: "none"` so a new build's
   * worker is never served from the HTTP cache.
   *
   * Synchronous and returns nothing — like {@link init}, it kicks the
   * registration off and the browser does the rest in the background. A
   * no-op where service workers don't exist (SSR, unsupported browsers).
   * When `NetworkConnection` is initialized the registration survives
   * connection drops (`restartIfNotFinishedWhenOnline`); otherwise it is a
   * single attempt. A registration that genuinely fails is reported to the
   * console — there is no meaningful recovery the caller could do.
   */
  static registerServiceWorker(): void {
    if (!hasServiceWorker()) return;
    // Initialized as disabled (dev) — there is no sw-min.js to register.
    if (OfflineTracker.opts?.disabled) return;
    const deploymentPath = OfflineTracker.opts
      ? OfflineTracker.opts.deploymentPath
      : normalizeDeploymentPath(readOfflineGlobalConfig()?.deploymentPath ?? "");
    const url = `${window.location.origin}${deploymentPath}/sw-min.js`;
    const register = async (): Promise<void> => {
      await navigator.serviceWorker.register(url, { updateViaCache: "none" });
    };
    const registration = isNetworkConnectionInitialized()
      ? NetworkConnection.restartIfNotFinishedWhenOnline(register)
      : register();
    registration.catch((error) => {
      console.error("[offline] registerServiceWorker() failed", error);
    });
  }

  /**
   * One tracking cycle: resolves once every critical asset — the built list
   * plus the current `additionalCriticalAssets` — is confirmed cached;
   * `additionalLazyLoadAssets` keep loading in the background and flip
   * {@link isOfflineReady} when done.
   *
   * Started by every {@link init} call and by `controllerchange`; a new
   * start supersedes the previous cycle, which stops silently. The cycle
   * survives connection drops: it pauses offline and resumes when the
   * connection returns.
   */
  private static async startTracking(): Promise<void> {
    const opts = OfflineTracker.opts as ResolvedOptions;
    const additional = OfflineTracker.lastAdditional ?? {
      additionalCriticalAssets: [],
      additionalLazyLoadAssets: [],
    };
    const myEpoch = ++OfflineTracker.epoch;
    const alive = (): boolean => OfflineTracker.initialized && myEpoch === OfflineTracker.epoch;

    OfflineTracker.setCriticalLoaded(false);
    OfflineTracker.setLazyLoaded(false);
    OfflineTracker.notCachedCritical.clear();
    OfflineTracker.notCachedLazy.clear();

    await OfflineTracker.listFetched;
    if (!alive()) return;

    const critical = [...OfflineTracker.criticalList, ...additional.additionalCriticalAssets].map(
      opts.mapAssetUrl,
    );
    const lazy = additional.additionalLazyLoadAssets.map(opts.mapAssetUrl);

    // First pass: everything may already be cached from a previous session.
    const criticalCached = await checkAssets(
      critical,
      OfflineTracker.notCachedCritical,
      opts.fetchFn,
    );
    if (!alive()) return;
    const lazyCached = await checkAssets(lazy, OfflineTracker.notCachedLazy, opts.fetchFn);
    if (!alive()) return;
    if (criticalCached) OfflineTracker.setCriticalLoaded(true);
    if (lazyCached) OfflineTracker.setLazyLoaded(true);
    if (criticalCached && lazyCached) return;

    // Loading goes through the worker's fetch handler, so wait for a worker
    // and give a fresh one a moment to take over the page.
    if (hasServiceWorker()) {
      await navigator.serviceWorker.ready;
      if (!alive()) return;
    }
    await delay(opts.swSettleDelay);
    if (!alive()) return;

    if (!lazyCached) {
      // Background on purpose: lazy assets gate the status, not this promise.
      void OfflineTracker.runLoadLoop(OfflineTracker.notCachedLazy, alive, (done) => {
        if (done) OfflineTracker.setLazyLoaded(true);
      });
    }
    if (!criticalCached) {
      await OfflineTracker.runLoadLoop(OfflineTracker.notCachedCritical, alive, (done) => {
        if (done) OfflineTracker.setCriticalLoaded(true);
      });
    }
  }

  /**
   * Register a listener for changes of {@link isOfflineReady} and get back
   * the function that detaches it.
   *
   * Only *changes* are delivered — the listener is not called on
   * subscription; read {@link isOfflineReady} for the current value. A
   * listener that throws is contained (reported to the console, the rest
   * still run). Subscribing and unsubscribing from inside a listener is
   * safe. {@link destroy} drops every subscription without a final call.
   */
  static subscribe(listener: OfflineTrackerListener): OfflineTrackerUnsubscribe {
    OfflineTracker.assertInitialized("subscribe()");
    if (typeof listener !== "function") {
      throw new Error("[offline] subscribe() needs a function");
    }
    // An entry object rather than the bare function: the same listener may be
    // subscribed more than once, and each registration has to be removable on
    // its own. The flag makes a second unsubscribe() a no-op instead of an
    // indexOf that finds — and drops — somebody else's identical entry.
    const subscription: Subscription = { listener, active: true };
    OfflineTracker.subscriptions.push(subscription);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      const index = OfflineTracker.subscriptions.indexOf(subscription);
      if (index !== -1) OfflineTracker.subscriptions.splice(index, 1);
    };
  }

  /** Resolves immediately when offline-ready, otherwise on the next transition to ready. */
  static whenOfflineReady(): Promise<void> {
    OfflineTracker.assertInitialized("whenOfflineReady()");
    if (OfflineTracker.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      OfflineTracker.readyWaiters.push({ resolve, reject });
    });
  }

  /**
   * Repair the cache after something went sideways. Without a controlling,
   * active service worker the cache state is untrustworthy — every cache is
   * deleted and the page reloads to start clean. With a healthy worker the
   * still-missing assets get one load-and-recheck round (the reconnect
   * watcher fires this again on the next drop, so no loop here).
   *
   * Runs automatically after the connection comes back while not ready —
   * see the `shouldStabilize` option — and can be called manually any time.
   */
  static async stabilizeCaching(): Promise<void> {
    OfflineTracker.assertInitialized("stabilizeCaching()");
    if (!hasServiceWorker()) return;
    const opts = OfflineTracker.opts as ResolvedOptions;
    // Disabled (dev): the cache state is not this library's to repair.
    if (opts.disabled) return;
    const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    if (!navigator.serviceWorker.controller || !registration?.active) {
      await deleteAllCaches();
      if (hasWindow()) window.location.reload();
      return;
    }
    // Sets are only meaningful once a tracking cycle populated them; before
    // that a recheck of an empty set would report a fully-loaded cache — a
    // lie. hadPending guards the same race per set.
    if (OfflineTracker.lastAdditional === null) return;
    const hadPendingCritical = OfflineTracker.notCachedCritical.size > 0;
    const hadPendingLazy = OfflineTracker.notCachedLazy.size > 0;
    await Promise.all([
      loadAssets([...OfflineTracker.notCachedCritical], opts.fetchFn),
      loadAssets([...OfflineTracker.notCachedLazy], opts.fetchFn),
    ]);
    const criticalCached = await checkAssets(
      [...OfflineTracker.notCachedCritical],
      OfflineTracker.notCachedCritical,
      opts.fetchFn,
    );
    const lazyCached = await checkAssets(
      [...OfflineTracker.notCachedLazy],
      OfflineTracker.notCachedLazy,
      opts.fetchFn,
    );
    if (hadPendingCritical && criticalCached) OfflineTracker.setCriticalLoaded(true);
    if (hadPendingLazy && lazyCached) OfflineTracker.setLazyLoaded(true);
  }

  /**
   * Undo {@link init}: stop every loading loop, detach the
   * `controllerchange` and network listeners, drop subscriptions without a
   * final call and reset the state. Pending {@link whenOfflineReady}
   * promises are rejected — leaving them pending would deadlock the code
   * awaiting them. No-op when not initialized.
   */
  static destroy(): void {
    if (!OfflineTracker.initialized) return;
    OfflineTracker.epoch += 1;
    OfflineTracker.generation += 1;
    if (OfflineTracker.controllerChangeHandler !== null && hasServiceWorker()) {
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        OfflineTracker.controllerChangeHandler,
      );
    }
    OfflineTracker.controllerChangeHandler = null;
    OfflineTracker.unsubscribeNetwork?.();
    OfflineTracker.unsubscribeNetwork = null;
    const error = new Error("[offline] destroyed while waiting to become offline-ready");
    for (const waiter of OfflineTracker.readyWaiters.splice(0)) waiter.reject(error);
    // Detach every listener without a final call: the reset below is
    // teardown, not an observation of the cache.
    for (const subscription of OfflineTracker.subscriptions.splice(0)) {
      subscription.active = false;
    }
    OfflineTracker.criticalLoaded = false;
    OfflineTracker.lazyLoaded = false;
    OfflineTracker.ready = false;
    OfflineTracker.notCachedCritical.clear();
    OfflineTracker.notCachedLazy.clear();
    OfflineTracker.criticalList = [];
    OfflineTracker.listFetched = null;
    OfflineTracker.lastAdditional = null;
    OfflineTracker.opts = null;
    OfflineTracker.initialized = false;
  }

  private static assertInitialized(member: string): void {
    if (!OfflineTracker.initialized) {
      throw new Error(`[offline] OfflineTracker.init() must be called before using ${member}`);
    }
  }

  /**
   * Fetch `critical-assets.json` through a client-side cache-first bucket
   * (`@dmytromykhailiuk/cache-request`): the bucket's copy is served when
   * present — no network round-trip per session — and a miss goes to the
   * network (HTTP-cache-bypassing) and caches the ok response. The bucket is
   * invalidated externally: the injected bootstrap wipes every cache when
   * `build-timestamp.txt` reveals a new build. A repeat visit that starts
   * offline initializes from the cached copy.
   *
   * With no cached copy the fetch is retried until an ok response is
   * delivered — the CLI always generates the file, so in production a
   * failure of any kind (network drop, 404, 5xx) is transient deploy state,
   * not a reason to give up. Waits for the connection while offline instead
   * of burning retries. Dev environments never reach this: they initialize
   * with `disabled: true`.
   */
  private static async fetchCriticalList(myGeneration: number): Promise<void> {
    const alive = (): boolean =>
      OfflineTracker.initialized && myGeneration === OfflineTracker.generation;
    while (alive()) {
      const opts = OfflineTracker.opts as ResolvedOptions;
      try {
        const response = await cacheFirst(
          opts.criticalAssetsUrl,
          () =>
            opts.fetchFn(opts.criticalAssetsUrl, {
              headers: { "Cache-Control": "no-cache" },
              cache: "no-store",
            }),
          { cacheName: CRITICAL_ASSETS_CACHE_NAME },
        );
        if (!alive()) return;
        if (response.ok) {
          // The CLI generates the file, so the body always parses — a json()
          // failure can only mean the transfer broke mid-body. That is a
          // network failure like any other: it rejects into the retry path
          // below instead of being mistaken for an empty list.
          const parsed: unknown = await response.json();
          const list = Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [];
          if (alive()) OfflineTracker.criticalList = list;
          return;
        }
        // Delivered non-ok — fall through to the retry path below.
      } catch {
        // Network failure (including a body that broke mid-transfer), or
        // offline with no cached copy — wait out the offline stretch and
        // try again.
      }
      if (!alive()) return;
      try {
        if (!isNetworkOnline()) await NetworkConnection.continueWhenOnline();
      } catch {
        return; // NetworkConnection destroyed while waiting.
      }
      if (!alive()) return;
      await delay((OfflineTracker.opts as ResolvedOptions).retryDelay);
    }
  }

  /**
   * Load-and-recheck until every asset in `notCached` is confirmed cached
   * (then `onDone(true)`), the cycle is superseded, or the tracker is
   * destroyed. Pauses while offline instead of burning retries.
   */
  private static async runLoadLoop(
    notCached: Set<string>,
    alive: () => boolean,
    onDone: (done: boolean) => void,
  ): Promise<void> {
    const opts = OfflineTracker.opts as ResolvedOptions;
    await loadAssets([...notCached], opts.fetchFn);
    if (!alive()) return;
    while (alive()) {
      const done = await checkAssets([...notCached], notCached, opts.fetchFn);
      if (!alive()) return;
      if (done) {
        onDone(true);
        return;
      }
      if (!isNetworkOnline()) {
        try {
          await NetworkConnection.continueWhenOnline();
        } catch {
          return; // NetworkConnection destroyed while waiting.
        }
        if (!alive()) return;
        await delay(opts.reconnectSettleDelay);
        if (!alive()) return;
      }
      await loadAssets([...notCached], opts.fetchFn);
      if (!alive()) return;
      await delay(opts.retryDelay);
    }
  }

  private static setCriticalLoaded(value: boolean): void {
    OfflineTracker.criticalLoaded = value;
    OfflineTracker.refreshReady();
  }

  private static setLazyLoaded(value: boolean): void {
    OfflineTracker.lazyLoaded = value;
    OfflineTracker.refreshReady();
  }

  private static refreshReady(): void {
    const next = OfflineTracker.criticalLoaded && OfflineTracker.lazyLoaded;
    if (next === OfflineTracker.ready) return;
    OfflineTracker.ready = next;
    if (next) {
      // Splice before resolving: a waiter that immediately re-awaits must
      // land in the fresh array, not the one being flushed.
      for (const waiter of OfflineTracker.readyWaiters.splice(0)) waiter.resolve();
    }
    OfflineTracker.notify(next);
  }

  private static notify(next: boolean): void {
    // Iterate a copy: a listener is free to subscribe or unsubscribe, which
    // would otherwise mutate the array mid-loop.
    for (const subscription of [...OfflineTracker.subscriptions]) {
      // Dropped by an earlier listener in this same round — its unsubscribe
      // has to take effect immediately, not from the next change on.
      if (!subscription.active) continue;
      // A listener may itself change the state (a synchronous track() or
      // destroy()). That nested dispatch already delivered the newer value,
      // so continuing here would hand out a stale one.
      if (OfflineTracker.ready !== next) return;
      try {
        subscription.listener(next);
      } catch (error) {
        console.error("[offline] a subscribe() listener threw", error);
      }
    }
  }
}
