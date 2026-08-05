import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineTracker } from "../src/index";
import {
  FakeEnv,
  cleanup,
  goOnline,
  initTracker,
  installServiceWorkerMock,
  setupEnv,
  waitFor,
  waitForReady,
} from "./helpers";

afterEach(cleanup);

describe("construction", () => {
  it("cannot be instantiated", () => {
    expect(() => new (OfflineTracker as unknown as new () => unknown)()).toThrow(
      "[offline] OfflineTracker is not constructable — use its static members",
    );
  });
});

describe("init() preconditions", () => {
  it("fails fast when NetworkConnection is not initialized", () => {
    const env = new FakeEnv();
    vi.stubGlobal("fetch", env.fetch);
    expect(() => OfflineTracker.init()).toThrow(
      "[offline] NetworkConnection.init() must be called before OfflineTracker.init()",
    );
    // The failed init must leave no trace.
    expect(() => OfflineTracker.status).toThrow();
  });

  it("validates delay options synchronously", async () => {
    await setupEnv();
    expect(() => initTracker({ retryDelay: -1 })).toThrow(
      '[offline] "retryDelay" must be a positive finite number',
    );
    expect(() => initTracker({ swSettleDelay: Number.NaN })).toThrow(
      '[offline] "swSettleDelay" must be a positive finite number',
    );
    // Validation failures must not mark the tracker initialized.
    expect(() => initTracker()).not.toThrow();
  });

  it("validates function options", async () => {
    await setupEnv();
    expect(() => initTracker({ modifyRequestHeaders: 42 as never })).toThrow(
      '[offline] "modifyRequestHeaders" must be a function',
    );
    expect(() => initTracker({ mapAssetUrl: "nope" as never })).toThrow(
      '[offline] "mapAssetUrl" must be a function',
    );
    expect(() => initTracker({ shouldStabilize: [] as never })).toThrow(
      '[offline] "shouldStabilize" must be a function',
    );
  });

  it("validates the additional asset lists", async () => {
    await setupEnv();
    expect(() => initTracker({ additionalCriticalAssets: [42] as never })).toThrow(
      '[offline] "additionalCriticalAssets" must be an array of strings',
    );
    expect(() => initTracker({ additionalLazyLoadAssets: "nope" as never })).toThrow(
      '[offline] "additionalLazyLoadAssets" must be an array of strings',
    );
  });
});

describe("access before init()", () => {
  it("throws from every stateful member", async () => {
    expect(() => OfflineTracker.status).toThrow(
      "[offline] OfflineTracker.init() must be called before using status",
    );
    expect(() => OfflineTracker.isOfflineReady).toThrow(
      "[offline] OfflineTracker.init() must be called before using isOfflineReady",
    );
    expect(() => OfflineTracker.subscribe(() => {})).toThrow(
      "[offline] OfflineTracker.init() must be called before using subscribe()",
    );
    expect(() => OfflineTracker.whenOfflineReady()).toThrow(
      "[offline] OfflineTracker.init() must be called before using whenOfflineReady()",
    );
    await expect(OfflineTracker.stabilizeCaching()).rejects.toThrow(
      "[offline] OfflineTracker.init() must be called before using stabilizeCaching()",
    );
  });

  it("destroy() is a safe no-op", () => {
    expect(() => OfflineTracker.destroy()).not.toThrow();
  });
});

describe("init() is callable once, reInit() restarts tracking", () => {
  it("init() throws on a second call", async () => {
    await setupEnv();
    initTracker();
    expect(() => initTracker()).toThrow(
      "[offline] already initialized — call reInit() to restart tracking, or destroy() to reconfigure",
    );
  });

  it("reInit() throws before init()", () => {
    expect(() => OfflineTracker.reInit()).toThrow(
      "[offline] OfflineTracker.init() must be called before using reInit()",
    );
  });

  it("reInit() restarts tracking with the new assets without refetching the list", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js").add("/extra.css");
    initTracker();
    await waitForReady();

    OfflineTracker.reInit({ additionalCriticalAssets: ["/extra.css"] });
    expect(OfflineTracker.isOfflineReady).toBe(false); // reset synchronously
    await waitForReady();
    expect(env.cached.has("/extra.css")).toBe(true);

    const listRequests = env.requests.filter((r) => r.url.endsWith("/critical-assets.json"));
    expect(listRequests).toHaveLength(1);
  });

  it("merges the asset lists of init() and every reInit()", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    env.available.add("/first.css").add("/second.css").add("/lazy.glb");
    initTracker({ additionalCriticalAssets: ["/first.css"] });
    await waitForReady();

    // reInit does not repeat /first.css — it must survive the merge.
    OfflineTracker.reInit({
      additionalCriticalAssets: ["/second.css"],
      additionalLazyLoadAssets: ["/lazy.glb"],
    });
    await waitForReady();
    expect(env.cached.has("/first.css")).toBe(true);
    expect(env.cached.has("/second.css")).toBe(true);
    expect(env.cached.has("/lazy.glb")).toBe(true);

    // An empty reInit() still tracks the accumulated union.
    env.cached.clear();
    OfflineTracker.reInit();
    await waitForReady();
    expect(env.cached.has("/first.css")).toBe(true);
    expect(env.cached.has("/second.css")).toBe(true);
  });

  it("reInit() validates its lists", async () => {
    await setupEnv();
    initTracker();
    expect(() => OfflineTracker.reInit({ additionalCriticalAssets: [42] as never })).toThrow(
      '[offline] "additionalCriticalAssets" must be an array of strings',
    );
  });
});

describe("modifyRequestHeaders", () => {
  it("is applied to every request the tracker makes", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js");
    initTracker({
      modifyRequestHeaders: (headers) => {
        headers.set("Authorization", "Bearer token-1");
        return headers;
      },
    });
    await waitForReady();
    // The list fetch, the cache probes and the loads all carry the header —
    // and the probe's own X-Cache-Only header survives the merge.
    const trackerCalls = env.fetch.mock.calls.filter(
      ([url]) => String(url).endsWith("/critical-assets.json") || String(url) === "/a.js",
    );
    expect(trackerCalls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of trackerCalls) {
      expect(init?.headers).toBeInstanceOf(Headers);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token-1");
    }
    expect(env.requests.some((r) => r.cacheOnly && r.url === "/a.js")).toBe(true);
  });
});

describe("critical-assets.json", () => {
  it("is fetched once on init, bypassing HTTP caches", async () => {
    const env = await setupEnv();
    env.criticalList = ["/main.js"];
    env.cached.add("/main.js");
    initTracker();
    await waitFor(() =>
      env.fetch.mock.calls.some(([url]) => String(url).endsWith("/critical-assets.json")),
    );
    const listRequest = env.fetch.mock.calls.find(([url]) =>
      String(url).endsWith("/critical-assets.json"),
    );
    expect(listRequest?.[1]).toMatchObject({ cache: "no-store" });
    expect(new Headers(listRequest?.[1]?.headers).get("Cache-Control")).toBe("no-cache");
  });

  it("uses the fetched list as the critical set", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/main.js", "/styles.css"];
    env.available.add("/main.js").add("/styles.css");
    initTracker();
    await waitForReady();
    expect(OfflineTracker.status).toEqual({
      criticalAssetsLoaded: true,
      lazyAssetsLoaded: true,
      allAssetsLoaded: true,
    });
    expect(env.cached.has("/main.js")).toBe(true);
    expect(env.cached.has("/styles.css")).toBe(true);
  });

  it("keeps retrying a delivered non-ok response until the file appears", async () => {
    const env = await setupEnv();
    env.listDeployed = false;
    env.criticalList = ["/main.js"];
    env.cached.add("/main.js");
    initTracker();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(OfflineTracker.isOfflineReady).toBe(false);

    env.listDeployed = true;
    await waitForReady();
  });

  it("retries a body that broke mid-transfer instead of accepting an empty list", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/main.js"];
    env.cached.add("/main.js");
    env.listBodyFailures = 1;
    initTracker();
    await waitForReady();
    // Two list attempts: the truncated one and the successful retry…
    expect(env.requests.filter((r) => r.url.endsWith("/critical-assets.json"))).toHaveLength(2);
    // …and readiness came from verifying the real list, not an empty one.
    expect(env.requests.some((r) => r.cacheOnly && r.url === "/main.js")).toBe(true);
  });

  it("derives the list URL from the injected deploymentPath global", async () => {
    const env = await setupEnv();
    window.__OFFLINE_CONFIG__ = { deploymentPath: "/client" };
    env.criticalList = [];
    initTracker();
    await waitFor(() =>
      env.requests.some((r) => r.url === `${window.location.origin}/client/critical-assets.json`),
    );
  });

  it("initializes fully offline from the cached list of a previous session", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    // The cache-first bucket holds the list a previous online session cached.
    const cachedListResponse = {
      ok: true,
      status: 200,
      clone: (): unknown => cachedListResponse,
      json: async () => ["/main.js"],
    };
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async (key: string) =>
          String(key).endsWith("/critical-assets.json") ? cachedListResponse : undefined,
        put: async () => {},
        keys: async () => [],
        delete: async () => true,
      }),
    });
    // The service worker cache already holds the asset; X-Cache-Only checks
    // work without the network.
    env.cached.add("/main.js");
    env.networkUp = false;
    window.dispatchEvent(new Event("offline"));

    initTracker();
    await waitForReady();
    // Ready without a single successful network request.
    expect(env.requests.filter((r) => !r.cacheOnly && r.url === "/main.js")).toEqual([]);
  });

  it("waits out an offline start and becomes ready once the connection appears", async () => {
    const env = await setupEnv();
    // Drop the network after NetworkConnection is up but before init().
    env.networkUp = false;
    window.dispatchEvent(new Event("offline"));
    env.criticalList = ["/main.js"];
    env.available.add("/main.js");

    initTracker();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(OfflineTracker.isOfflineReady).toBe(false);

    await goOnline(env);
    await waitForReady();
  });
});

describe("destroy()", () => {
  it("resets everything and allows a clean re-init", async () => {
    const env = await setupEnv();
    env.criticalList = [];
    initTracker();
    await waitForReady();

    OfflineTracker.destroy();
    expect(() => OfflineTracker.status).toThrow();

    initTracker();
    expect(OfflineTracker.isOfflineReady).toBe(false);
    await waitForReady();
  });
});
