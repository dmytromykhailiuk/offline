import { afterEach, describe, expect, it } from "vitest";
import { OfflineTracker } from "../src/index";
import { cleanup, initTracker, installServiceWorkerMock, setupEnv, waitForReady } from "./helpers";

afterEach(cleanup);

describe("whenOfflineReady()", () => {
  it("resolves immediately when already ready", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    await waitForReady();
    await expect(OfflineTracker.whenOfflineReady()).resolves.toBeUndefined();
  });

  it("resolves on the transition to ready", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    initTracker();
    let settled = false;
    const gate = OfflineTracker.whenOfflineReady().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(settled).toBe(false);
    env.available.add("/a.js");
    await gate;
    expect(settled).toBe(true);
  });

  it("every pending waiter resolves, and new waiters resolve instantly after", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js");
    initTracker();
    const gates = [OfflineTracker.whenOfflineReady(), OfflineTracker.whenOfflineReady()];
    await expect(Promise.all(gates)).resolves.toBeDefined();
    await expect(OfflineTracker.whenOfflineReady()).resolves.toBeUndefined();
  });

  it("destroy() rejects pending waiters instead of leaving them hanging", async () => {
    const env = await setupEnv();
    env.criticalList = ["/never.js"];
    initTracker();
    const gate = OfflineTracker.whenOfflineReady();
    OfflineTracker.destroy();
    await expect(gate).rejects.toThrow("[offline] destroyed while waiting to become offline-ready");
  });
});
