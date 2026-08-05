import { afterEach, describe, expect, it } from "vitest";
import { OfflineTracker } from "../src/index";
import {
  cleanup,
  goOffline,
  goOnline,
  initTracker,
  installServiceWorkerMock,
  setupEnv,
  waitFor,
  waitForReady,
} from "./helpers";

afterEach(cleanup);

describe("tracking started by init()", () => {
  it("reports ready without loading when everything is already cached", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js", "/b.css"];
    env.cached.add("/a.js").add("/b.css");
    initTracker();
    await waitForReady();
    // Already cached — the check round is all it took, nothing was loaded.
    const loads = env.requests.filter((r) => !r.cacheOnly && r.url.startsWith("/"));
    expect(loads).toEqual([]);
  });

  it("loads missing assets through the worker and then reports ready", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js", "/b.css"];
    env.available.add("/a.js").add("/b.css");
    initTracker();
    await waitForReady();
    expect(env.cached.has("/a.js")).toBe(true);
    expect(env.cached.has("/b.css")).toBe(true);
  });

  it("keeps retrying an asset the server cannot deliver yet", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/late.js"];
    initTracker();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(OfflineTracker.isOfflineReady).toBe(false);
    env.available.add("/late.js");
    await waitForReady();
  });

  it("adds additionalCriticalAssets to the built list", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js").add("/themes/prod.css");
    initTracker({ additionalCriticalAssets: ["/themes/prod.css"] });
    await waitForReady();
    expect(env.cached.has("/themes/prod.css")).toBe(true);
  });

  it("flips criticalAssetsLoaded first, lazy assets keep loading in the background", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js");
    // The lazy asset is not deliverable yet — critical readiness must not wait.
    initTracker({ additionalLazyLoadAssets: ["/models/big.glb"] });
    await waitFor(() => OfflineTracker.status.criticalAssetsLoaded);
    expect(OfflineTracker.status.lazyAssetsLoaded).toBe(false);
    expect(OfflineTracker.isOfflineReady).toBe(false);

    env.available.add("/models/big.glb");
    await waitForReady();
    expect(OfflineTracker.status.lazyAssetsLoaded).toBe(true);
  });

  it("applies mapAssetUrl to every asset before requesting it", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/theme-{v}.css"];
    env.available.add("/theme-2.css").add("/logo-2.svg");
    initTracker({
      mapAssetUrl: (url) => url.replace("{v}", "2"),
      additionalCriticalAssets: ["/logo-{v}.svg"],
    });
    await waitForReady();
    // Only mapped URLs ever hit the network.
    expect(env.requests.some((r) => r.url.includes("{v}"))).toBe(false);
    expect(env.requests.some((r) => r.url === "/theme-2.css")).toBe(true);
    expect(env.requests.some((r) => r.url === "/logo-2.svg")).toBe(true);
  });

  it("a reInit() supersedes the previous cycle without duplicate notifications", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/never.js"];
    initTracker();
    const notifications: boolean[] = [];
    OfflineTracker.subscribe((ready) => notifications.push(ready));
    await new Promise((resolve) => setTimeout(resolve, 15));

    env.cached.add("/never.js").add("/instant.js");
    OfflineTracker.reInit({ additionalCriticalAssets: ["/instant.js"] });
    await waitForReady();
    // One transition to ready — the superseded cycle contributed nothing.
    expect(notifications).toEqual([true]);
  });

  it("restarts with the last additional assets on controllerchange", async () => {
    const env = await setupEnv();
    const swMock = installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js").add("/extra.css");
    initTracker({ additionalCriticalAssets: ["/extra.css"] });
    await waitForReady();

    const notifications: boolean[] = [];
    OfflineTracker.subscribe((ready) => notifications.push(ready));

    // A new worker took over with a wiped cache.
    env.cached.clear();
    swMock.emitControllerChange();
    await waitFor(() => notifications.length >= 2);
    expect(notifications).toEqual([false, true]);
    expect(env.cached.has("/extra.css")).toBe(true);
  });

  it("pauses while offline and resumes when the connection returns", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    initTracker();
    await waitFor(() => env.requests.some((r) => r.url === "/a.js"));

    goOffline(env);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(OfflineTracker.isOfflineReady).toBe(false);
    const requestsWhileOffline = env.requests.filter((r) => !r.cacheOnly).length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Parked, not spinning: no new network attempts while offline.
    expect(env.requests.filter((r) => !r.cacheOnly).length).toBe(requestsWhileOffline);

    env.available.add("/a.js");
    await goOnline(env);
    await waitForReady();
  });
});
