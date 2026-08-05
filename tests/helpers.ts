import { NetworkConnection } from "@dmytromykhailiuk/network-connection";
import { vi } from "vitest";
import { OfflineTracker } from "../src/index";
import type { OfflineTrackerOptions } from "../src/index";

export const HEALTH_URL = "https://health.example/ping";

interface StubResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

const ok = (): StubResponse => ({ ok: true, status: 200, json: async () => ({}) });
const okJson = (value: unknown): StubResponse => ({
  ok: true,
  status: 200,
  json: async () => value,
});
const notFound = (): StubResponse => ({ ok: false, status: 404, json: async () => ({}) });

const headerValue = (headers: unknown, name: string): string | null => {
  if (!headers || typeof headers !== "object") return null;
  // The tracker sends Headers instances; NetworkConnection sends plain objects.
  if (headers instanceof Headers) return headers.get(name);
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
};

/**
 * One stub playing the whole stack: the network, the server and the generated
 * service worker's cache semantics.
 *
 * - `X-Cache-Only` requests answer from `cached` (reject when absent) and
 *   ignore the network state, like the real worker's cache-only branch.
 * - Plain asset requests need the network up; when the asset is in
 *   `available` the response is ok and the asset lands in `cached` — the
 *   worker's cache-first side effect. Otherwise a delivered 404.
 * - The healthcheck URL and `critical-assets.json` answer when the network
 *   is up (the latter with `criticalList`, or 404 when `listDeployed` is off).
 */
export class FakeEnv {
  readonly cached = new Set<string>();
  readonly available = new Set<string>();
  criticalList: string[] = [];
  listDeployed = true;
  /** N next list responses deliver ok headers but a body that dies mid-read. */
  listBodyFailures = 0;
  networkUp = true;
  readonly requests: Array<{ url: string; cacheOnly: boolean }> = [];

  readonly fetch = vi.fn(async (input: unknown, init?: RequestInit): Promise<StubResponse> => {
    const url =
      typeof input === "string" ? input : String((input as { url?: string })?.url ?? input);
    const cacheOnly = headerValue(init?.headers, "X-Cache-Only") === "true";
    this.requests.push({ url, cacheOnly });
    if (cacheOnly) {
      if (this.cached.has(url)) return ok();
      throw new TypeError("Failed to fetch");
    }
    if (!this.networkUp) throw new TypeError("Failed to fetch");
    if (url === HEALTH_URL) return ok();
    if (url.endsWith("/critical-assets.json")) {
      if (!this.listDeployed) return notFound();
      if (this.listBodyFailures > 0) {
        this.listBodyFailures -= 1;
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new TypeError("Failed to fetch (body died mid-transfer)");
          },
        };
      }
      return okJson(this.criticalList);
    }
    if (this.available.has(url)) {
      this.cached.add(url);
      return ok();
    }
    return notFound();
  });
}

/** Stub fetch globally and bring the real NetworkConnection online against it. */
export const setupEnv = async (): Promise<FakeEnv> => {
  const env = new FakeEnv();
  vi.stubGlobal("fetch", env.fetch);
  await NetworkConnection.init(HEALTH_URL);
  return env;
};

/** Millisecond-scale delays so the loading loops spin fast under real timers. */
export const FAST_DELAYS: OfflineTrackerOptions = {
  swSettleDelay: 1,
  retryDelay: 5,
  reconnectSettleDelay: 1,
};

export const initTracker = (options: OfflineTrackerOptions = {}): void => {
  OfflineTracker.init({ ...FAST_DELAYS, ...options });
};

/** The tracking a fresh init() kicks off has finished — everything is cached. */
export const waitForReady = (): Promise<void> => waitFor(() => OfflineTracker.isOfflineReady);

export interface ServiceWorkerMock {
  controller: object | null;
  ready: Promise<unknown>;
  register: ReturnType<typeof vi.fn>;
  getRegistration: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emitControllerChange: () => void;
  controllerChangeListeners: Set<() => void>;
}

export const installServiceWorkerMock = (): ServiceWorkerMock => {
  const controllerChangeListeners = new Set<() => void>();
  const registration = { active: {} };
  const mock: ServiceWorkerMock = {
    controller: {},
    ready: Promise.resolve(registration),
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
    addEventListener: (type, listener) => {
      if (type === "controllerchange") controllerChangeListeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      controllerChangeListeners.delete(listener);
    },
    emitControllerChange: () => {
      for (const listener of [...controllerChangeListeners]) listener();
    },
    controllerChangeListeners,
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: mock,
    configurable: true,
  });
  return mock;
};

export const removeServiceWorkerMock = (): void => {
  Reflect.deleteProperty(navigator, "serviceWorker");
};

export const goOffline = (env: FakeEnv): void => {
  env.networkUp = false;
  window.dispatchEvent(new Event("offline"));
};

export const goOnline = async (env: FakeEnv): Promise<void> => {
  env.networkUp = true;
  window.dispatchEvent(new Event("online"));
  await flushAsync();
};

/** Drain the microtask queue so settled promises run their continuations. */
export const flushAsync = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

/** Poll under real timers until `predicate` holds — the loops run on tiny delays. */
export const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor(): condition never held");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

export const cleanup = (): void => {
  OfflineTracker.destroy();
  NetworkConnection.destroy();
  removeServiceWorkerMock();
  (window as { __OFFLINE_CONFIG__?: unknown }).__OFFLINE_CONFIG__ = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
};
