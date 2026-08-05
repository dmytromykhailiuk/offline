import { NetworkConnection } from "@dmytromykhailiuk/network-connection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfflineTracker } from "../src/index";
import {
  FakeEnv,
  cleanup,
  flushAsync,
  initTracker,
  installServiceWorkerMock,
  setupEnv,
  waitFor,
} from "./helpers";

afterEach(cleanup);

describe("registerServiceWorker()", () => {
  it("is a silent no-op where service workers do not exist", () => {
    expect(() => OfflineTracker.registerServiceWorker()).not.toThrow();
    expect(OfflineTracker.registerServiceWorker()).toBeUndefined();
  });

  it("registers ${origin}/sw-min.js by default, without init() or NetworkConnection", async () => {
    const mock = installServiceWorkerMock();
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(mock.register).toHaveBeenCalledWith(`${window.location.origin}/sw-min.js`, {
      updateViaCache: "none",
    });
  });

  it("honors the deploymentPath injected by offline-postbuild", async () => {
    const mock = installServiceWorkerMock();
    window.__OFFLINE_CONFIG__ = { deploymentPath: "/client" };
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(mock.register).toHaveBeenCalledWith(`${window.location.origin}/client/sw-min.js`, {
      updateViaCache: "none",
    });
  });

  it("normalizes a deploymentPath without a leading slash", async () => {
    const mock = installServiceWorkerMock();
    window.__OFFLINE_CONFIG__ = { deploymentPath: "web/" };
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(mock.register).toHaveBeenCalledWith(`${window.location.origin}/web/sw-min.js`, {
      updateViaCache: "none",
    });
  });

  it("uses the same global-derived path after init()", async () => {
    const mock = installServiceWorkerMock();
    window.__OFFLINE_CONFIG__ = { deploymentPath: "/from-global" };
    await setupEnv();
    initTracker();
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(mock.register).toHaveBeenCalledWith(`${window.location.origin}/from-global/sw-min.js`, {
      updateViaCache: "none",
    });
  });

  it("goes through NetworkConnection's restart wrapper when it is initialized", async () => {
    const mock = installServiceWorkerMock();
    await setupEnv();
    const restart = vi.spyOn(NetworkConnection, "restartIfNotFinishedWhenOnline");
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(mock.register).toHaveBeenCalledTimes(1);
  });

  it("registers plainly when NetworkConnection is not initialized", async () => {
    const mock = installServiceWorkerMock();
    const env = new FakeEnv();
    vi.stubGlobal("fetch", env.fetch);
    OfflineTracker.registerServiceWorker();
    await waitFor(() => mock.register.mock.calls.length > 0);
    expect(mock.register).toHaveBeenCalledTimes(1);
  });

  it("reports a genuine registration failure to the console", async () => {
    const mock = installServiceWorkerMock();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mock.register.mockRejectedValueOnce(new Error("registration blew up"));
    OfflineTracker.registerServiceWorker();
    await waitFor(() => consoleError.mock.calls.length > 0);
    expect(consoleError).toHaveBeenCalledWith(
      "[offline] registerServiceWorker() failed",
      expect.any(Error),
    );
    await flushAsync();
  });
});
