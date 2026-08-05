import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineTracker } from "../src/index";
import {
  cleanup,
  initTracker,
  installServiceWorkerMock,
  setupEnv,
  waitFor,
  waitForReady,
} from "./helpers";

afterEach(cleanup);

describe("status", () => {
  it("returns a fresh snapshot object on every read", async () => {
    await setupEnv();
    initTracker();
    const first = OfflineTracker.status;
    const second = OfflineTracker.status;
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it("starts all-false right after init", async () => {
    const env = await setupEnv();
    env.criticalList = ["/never.js"];
    initTracker();
    expect(OfflineTracker.status).toEqual({
      criticalAssetsLoaded: false,
      lazyAssetsLoaded: false,
      allAssetsLoaded: false,
    });
  });
});

describe("subscribe()", () => {
  it("rejects non-function listeners", async () => {
    await setupEnv();
    initTracker();
    expect(() => OfflineTracker.subscribe(null as never)).toThrow(
      "[offline] subscribe() needs a function",
    );
  });

  it("is not called on subscription, only on changes", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    const listener = vi.fn();
    OfflineTracker.subscribe(listener);
    await waitForReady();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("hears both directions of the transition", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = ["/a.js"];
    env.available.add("/a.js");
    initTracker();
    const seen: boolean[] = [];
    OfflineTracker.subscribe((ready) => seen.push(ready));

    await waitForReady();
    expect(seen).toEqual([true]);

    // Re-running tracking against a wiped cache drops readiness first.
    env.cached.clear();
    OfflineTracker.reInit();
    expect(seen).toEqual([true, false]);
    await waitForReady();
    expect(seen).toEqual([true, false, true]);
  });

  it("unsubscribe is idempotent and per-registration", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    const listener = vi.fn();
    const unsubFirst = OfflineTracker.subscribe(listener);
    OfflineTracker.subscribe(listener); // same fn, second registration stays
    unsubFirst();
    unsubFirst(); // no-op, must not drop the second registration
    await waitForReady();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing listener and still calls the rest", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    OfflineTracker.subscribe(() => {
      throw new Error("broken subscriber");
    });
    OfflineTracker.subscribe(second);
    await waitFor(() => second.mock.calls.length > 0);
    expect(second).toHaveBeenCalledWith(true);
    expect(consoleError).toHaveBeenCalledWith(
      "[offline] a subscribe() listener threw",
      expect.any(Error),
    );
  });

  it("a listener unsubscribed mid-dispatch is skipped in that round", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    const second = vi.fn();
    let unsubSecond: () => void = () => {};
    OfflineTracker.subscribe(() => {
      unsubSecond();
    });
    unsubSecond = OfflineTracker.subscribe(second);
    await waitForReady();
    expect(second).not.toHaveBeenCalled();
  });

  it("destroy() drops subscriptions without a final call", async () => {
    const env = await setupEnv();
    installServiceWorkerMock();
    env.criticalList = [];
    initTracker();
    await waitForReady();
    const listener = vi.fn();
    OfflineTracker.subscribe(listener);
    OfflineTracker.destroy();
    expect(listener).not.toHaveBeenCalled();
  });
});
