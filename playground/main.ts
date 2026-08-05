import { NetworkConnection } from "@dmytromykhailiuk/network-connection";
import { OfflineTracker } from "../src/index";

/* ── the simulated stack ──────────────────────────────────────────────
   A fetch stub reproducing the generated worker's protocol:
   - `X-Cache-Only: true`  → answered from `cached`, or rejected
   - plain asset request   → needs the network; when the "server" has the
     asset it responds ok and the asset lands in `cached` (cache-first)
   - critical-assets.json and the healthcheck answer while the network is up
   The tracker below is the real library, unmodified. */

const CRITICAL = ["/app/main.js", "/app/styles.css", "/app/logo.svg"];
const EXTRA_CRITICAL = ["/app/theme-dark.css"];
const EXTRA_LAZY = ["/app/models/big.glb"];

const cached = new Set<string>();
const available = new Set<string>();
let networkUp = true;

const HEALTH_URL = "/playground-health";

const headerValue = (headers: HeadersInit | undefined, name: string): string | null => {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  for (const [key, value] of entries) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return null;
};

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
  const pathname = url.startsWith("http") ? new URL(url).pathname : url;
  const cacheOnly = headerValue(init?.headers, "X-Cache-Only") === "true";

  if (cacheOnly) {
    logRequest(pathname, "cache-only", cached.has(pathname) ? "hit" : "miss");
    if (cached.has(pathname)) return new Response("cached");
    throw new TypeError("Failed to fetch (not cached)");
  }
  if (!networkUp) {
    logRequest(pathname, "network", "offline");
    throw new TypeError("Failed to fetch (network down)");
  }
  if (pathname === HEALTH_URL) return new Response("ok");
  if (pathname.endsWith("/critical-assets.json")) {
    logRequest(pathname, "network", "200");
    return new Response(JSON.stringify(CRITICAL), {
      headers: { "Content-Type": "application/json" },
    });
  }
  if (available.has(pathname)) {
    cached.add(pathname);
    logRequest(pathname, "network", "200 → cached");
    render();
    return new Response("asset");
  }
  logRequest(pathname, "network", "404");
  return new Response("not found", { status: 404 });
}) as typeof fetch;

/* ── tiny DOM helpers ─────────────────────────────────────────────── */

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const on = (id: string, fn: () => void) => $(id).addEventListener("click", fn);

const logEl = $("log");
const log = (key: string, message: string) => {
  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<span class="t">${time}</span><span class="k">${key}</span>`;
  line.append(message);
  logEl.prepend(line);
};

let requestCount = 0;
const logRequest = (url: string, kind: string, outcome: string) => {
  // Keep the log readable — the retry loop can be chatty.
  requestCount += 1;
  if (requestCount > 400) return;
  log("fetch", `${kind} ${url} — ${outcome}`);
};

const setBadge = (id: string, text: string, className: string) => {
  const badge = $(id);
  badge.textContent = text;
  badge.className = `badge ${className}`;
};

const render = () => {
  $("server-value").textContent = available.size
    ? `available:\n${[...available].join("\n")}`
    : "server has no assets yet — loads return 404";
  $("cache-value").textContent = cached.size ? [...cached].join("\n") : "empty";
  try {
    const status = OfflineTracker.status;
    $("status-value").textContent = JSON.stringify(status, null, 2);
    setBadge(
      "ready-badge",
      status.allAssetsLoaded ? "isOfflineReady" : "not ready",
      status.allAssetsLoaded ? "on" : "warn",
    );
  } catch {
    $("status-value").textContent = "OfflineTracker not initialized";
    setBadge("ready-badge", "no init", "");
  }
  try {
    const online = NetworkConnection.isOnline;
    $("net-value").textContent = `NetworkConnection.isOnline === ${online}`;
    setBadge("net-badge", online ? "online" : "offline", online ? "on" : "warn");
  } catch {
    /* not initialized yet */
  }
};

/* ── boot: the real startup sequence ──────────────────────────────── */

const boot = async () => {
  await NetworkConnection.init(HEALTH_URL);
  NetworkConnection.subscribe((isOnline) => {
    log("network", `subscribe → isOnline = ${isOnline}`);
    render();
  });
  log("network", "NetworkConnection.init() done");

  // The build-time convention, hand-set here: offline-postbuild injects this
  // global into index.html; init() derives every URL from it.
  window.__OFFLINE_CONFIG__ = { deploymentPath: "/app" };

  // In this stub there is no sw-min.js to register — in a real build this
  // is `OfflineTracker.registerServiceWorker()` right here.
  OfflineTracker.init({
    swSettleDelay: 300,
    retryDelay: 1500,
    reconnectSettleDelay: 250,
  });
  log("tracker", "OfflineTracker.init() — tracking kicked off in the background");
  OfflineTracker.subscribe((isReady) => {
    log("tracker", `subscribe → isOfflineReady = ${isReady}`);
    render();
  });
  render();
};

void boot();

/* ── controls ─────────────────────────────────────────────────────── */

on("net-offline", () => {
  networkUp = false;
  window.dispatchEvent(new Event("offline"));
  log("network", "simulated network cut");
  render();
});

on("net-online", () => {
  networkUp = true;
  window.dispatchEvent(new Event("online"));
  log("network", "simulated network restored");
  render();
});

on("server-deploy", () => {
  for (const asset of [...CRITICAL, ...EXTRA_CRITICAL, ...EXTRA_LAZY]) available.add(asset);
  log("server", "assets deployed — the retry loop will pick them up");
  render();
});

on("server-undeploy", () => {
  available.clear();
  log("server", "assets dropped from the server");
  render();
});

on("cache-wipe", () => {
  cached.clear();
  log("cache", "worker cache wiped — re-run track() to re-verify");
  render();
});

on("tracker-track", () => {
  // reInit() restarts tracking with the accumulated assets; the list is
  // not refetched.
  OfflineTracker.reInit();
  log("tracker", "reInit() — tracking restarted with the accumulated assets");
  render();
});

on("tracker-track-extra", () => {
  OfflineTracker.reInit({
    additionalCriticalAssets: EXTRA_CRITICAL,
    additionalLazyLoadAssets: EXTRA_LAZY,
  });
  log("tracker", "reInit({ additionalCriticalAssets, additionalLazyLoadAssets }) — merged in");
  render();
});

on("tracker-stabilize", () => {
  OfflineTracker.stabilizeCaching()
    .then(() => {
      log("tracker", "stabilizeCaching() resolved");
      render();
    })
    .catch((error) => log("tracker", `stabilizeCaching() rejected: ${error.message}`));
});

on("tracker-destroy", () => {
  OfflineTracker.destroy();
  log("tracker", "destroy() — reload the page to re-init");
  render();
});

setInterval(render, 1000);
