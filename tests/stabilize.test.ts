import { afterEach, describe, expect, it, vi } from "vitest";
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

const stubLocationReload = (): ReturnType<typeof vi.fn> => {
  const reload = vi.fn();
  const original = window.location;
  vi.stubGlobal("location", {
    origin: original.origin,
    href: original.href,
    pathname: original.pathname,
    reload,
  });
  return reload;
};

const stubCaches = (): { deleted: string[] } => {
  const state = { deleted: [] as string[] };
  vi.stubGlobal("caches", {
    keys: async () => ["custom-index-cache", "assets-cache"],
    delete: async (key: string) => {
      state.deleted.push(key);
      return true;
    },
  });
  return state;
};

describe("stabilizeCaching()", () => {
  it("wipes every cache and reloads when no worker controls the page", async () => {
    const env = await setupEnv();
    const swMock = installServiceWorkerMock();
    swMock.controller = null;
    swMock.getRegistration.mockResolvedValue(undefined);
    const cachesState = stubCaches();
    const reload = stubLocationReload();
    env.criticalList = [];
    initTracker();
    await waitForReady();
    await OfflineTracker.stabilizeCaching();
    expect(cachesState.deleted).toEqual(["custom-index-cache", "assets-cache"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("fills the cache gaps and flips readiness with a healthy worker", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    // The cycle parks in its long retry delay after the first failed round.
    initTracker({ retryDelay: 60_000 });
    await waitFor(() => env.requests.some((r) => !r.cacheOnly && r.url === "/a.js"));
    expect(OfflineTracker.isOfflineReady).toBe(false);

    env.available.add("/a.js");
    await OfflineTracker.stabilizeCaching();
    expect(OfflineTracker.isOfflineReady).toBe(true);
  });

  it("runs automatically when the connection comes back while not ready", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    initTracker({ retryDelay: 60_000 });
    await waitFor(() => env.requests.some((r) => !r.cacheOnly && r.url === "/a.js"));

    goOffline(env);
    env.available.add("/a.js");
    await goOnline(env);
    await waitFor(() => OfflineTracker.isOfflineReady);
  });

  it("respects shouldStabilize returning false", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    initTracker({ retryDelay: 60_000, shouldStabilize: () => false });
    await waitFor(() => env.requests.some((r) => !r.cacheOnly && r.url === "/a.js"));

    goOffline(env);
    env.available.add("/a.js");
    const assetLoads = () => env.requests.filter((r) => !r.cacheOnly && r.url === "/a.js").length;
    const before = assetLoads();
    await goOnline(env);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(assetLoads()).toBe(before);
    expect(OfflineTracker.isOfflineReady).toBe(false);
  });

  it("does not run on reconnect when already ready", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js");
    initTracker();
    await waitForReady();

    const stabilize = vi.spyOn(OfflineTracker, "stabilizeCaching");
    goOffline(env);
    await goOnline(env);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(stabilize).not.toHaveBeenCalled();
  });
});
