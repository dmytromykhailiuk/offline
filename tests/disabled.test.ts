import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineTracker } from "../src/index";
import { cleanup, initTracker, installServiceWorkerMock, setupEnv, waitForReady } from "./helpers";

afterEach(cleanup);

describe("init({ disabled: true }) — dev environments", () => {
  it("initializes inert, without NetworkConnection and without requests", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // No NetworkConnection.init() on purpose — the precondition is skipped.
    OfflineTracker.init({ disabled: true });
    expect(OfflineTracker.status).toEqual({
      criticalAssetsLoaded: false,
      lazyAssetsLoaded: false,
      allAssetsLoaded: false,
    });
    expect(OfflineTracker.isOfflineReady).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reInit() stays a no-op — readiness stays false, nothing is requested", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    OfflineTracker.init({ disabled: true });
    const listener = vi.fn();
    OfflineTracker.subscribe(listener);
    OfflineTracker.reInit({ additionalCriticalAssets: ["/a.js"] });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(OfflineTracker.isOfflineReady).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registerServiceWorker() skips registration", async () => {
    const swMock = installServiceWorkerMock();
    OfflineTracker.init({ disabled: true });
    OfflineTracker.registerServiceWorker();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(swMock.register).not.toHaveBeenCalled();
  });

  it("stabilizeCaching() is a no-op", async () => {
    const swMock = installServiceWorkerMock();
    OfflineTracker.init({ disabled: true });
    await OfflineTracker.stabilizeCaching();
    expect(swMock.getRegistration).not.toHaveBeenCalled();
  });

  it("whenOfflineReady() stays pending and is rejected by destroy()", async () => {
    OfflineTracker.init({ disabled: true });
    const gate = OfflineTracker.whenOfflineReady();
    OfflineTracker.destroy();
    await expect(gate).rejects.toThrow("[offline] destroyed while waiting to become offline-ready");
  });

  it("validates the option", () => {
    expect(() => OfflineTracker.init({ disabled: "yes" as never })).toThrow(
      '[offline] "disabled" must be a boolean',
    );
  });

  it("destroy() resets a disabled tracker and a real re-init works", async () => {
    OfflineTracker.init({ disabled: true });
    OfflineTracker.destroy();
    expect(() => OfflineTracker.status).toThrow();

    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.cached.add("/a.js");
    initTracker();
    await waitForReady();
  });

  it("disabled: false behaves exactly like the default", async () => {
    const env = await setupEnv();
    env.criticalList = [];
    initTracker({ disabled: false });
    await waitForReady();
  });
});
