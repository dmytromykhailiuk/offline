// @vitest-environment node
import { describe, expect, it } from "vitest";

describe("ssr", () => {
  it("imports without window", async () => {
    expect(typeof window).toBe("undefined");
    const { OfflineTracker } = await import("../src/index");
    expect(typeof OfflineTracker).toBe("function");
  });

  it("registerServiceWorker() is a silent no-op without service worker support", async () => {
    const { OfflineTracker } = await import("../src/index");
    expect(() => OfflineTracker.registerServiceWorker()).not.toThrow();
    expect(OfflineTracker.registerServiceWorker()).toBeUndefined();
  });

  it("destroy() is a safe no-op", async () => {
    const { OfflineTracker } = await import("../src/index");
    expect(() => OfflineTracker.destroy()).not.toThrow();
  });

  it("stateful members still fail fast, not crash on missing globals", async () => {
    const { OfflineTracker } = await import("../src/index");
    expect(() => OfflineTracker.status).toThrow(
      "[offline] OfflineTracker.init() must be called before using status",
    );
  });
});
