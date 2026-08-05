export const INJECT_MARKER_START = "<!-- offline-postbuild:start -->";
export const INJECT_MARKER_END = "<!-- offline-postbuild:end -->";

/**
 * The bootstrap injected into `<head>` as the first script. Plain pre-ES2015
 * JS — it runs before any bundle, on whatever browser shows up. It:
 *
 * 1. publishes `window.__OFFLINE_CONFIG__` (the build-time deploymentPath —
 *    the convention `OfflineTracker.registerServiceWorker()` reads);
 * 2. fixes the service worker scope: `/app` → `/app/` (a worker registered
 *    under `/app/sw-min.js` does not control `/app` without the slash);
 * 3. arms chunk-load-error recovery: a `ChunkLoadError` while offline means
 *    a not-fully-cached build — reload once the connection returns;
 * 4. compares `build-timestamp.txt` with the remembered one and clears every
 *    cache on a new build, so the worker re-caches the new version.
 */
export const buildBootstrapScript = (deploymentPath: string): string => {
  const config = JSON.stringify({ deploymentPath });
  // First in the head, so it wins over any pre-existing manifest link.
  const manifestLink = `<link rel="manifest" href="${deploymentPath}/manifest.webmanifest" />`;
  const script = `window.__OFFLINE_CONFIG__ = ${config};
(function () {
  "use strict";
  var deploymentPath = window.__OFFLINE_CONFIG__.deploymentPath;

  if (!deploymentPath && window.location.pathname === "") {
    window.location.replace(
      window.location.origin + "/" + window.location.search + window.location.hash
    );
    return;
  }

  if (deploymentPath && window.location.pathname === deploymentPath) {
    window.location.replace(
      window.location.origin + deploymentPath + "/" + window.location.search + window.location.hash
    );
    return;
  }

  var isWaitingForRecovery = false;
  function handleNetworkRecovery() {
    if (isWaitingForRecovery) return;
    isWaitingForRecovery = true;
    window.addEventListener(
      "online",
      function () {
        window.location.reload();
      },
      { once: true }
    );
  }

  function isChunkError(error) {
    var message = (error && error.message) || "";
    var name = (error && error.name) || (error && error.error && error.error.name);
    return message.indexOf("Loading chunk") !== -1 || name === "ChunkLoadError";
  }

  window.addEventListener("unhandledrejection", function (event) {
    if (isChunkError(event.reason)) {
      handleNetworkRecovery();
    }
  });

  window.addEventListener("error", function (event) {
    if (isChunkError(event.error) || isChunkError(event)) {
      handleNetworkRecovery();
    }
  });

  function deleteNetworkCaches() {
    if (typeof caches === "undefined") return Promise.resolve();
    return caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          return caches.delete(key);
        })
      );
    });
  }

  var lastBuildTimestamp = null;
  try {
    lastBuildTimestamp = localStorage.getItem("__BUILD_TIMESTAMP__");
  } catch (error) {}

  fetch(window.location.origin + deploymentPath + "/build-timestamp.txt", {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" }
  })
    .then(function (response) {
      return response.text();
    })
    .catch(function () {
      return null;
    })
    .then(function (currentBuildTimestamp) {
      if (!currentBuildTimestamp) return;
      try {
        localStorage.setItem("__BUILD_TIMESTAMP__", currentBuildTimestamp);
      } catch (error) {}
      if (lastBuildTimestamp && currentBuildTimestamp !== lastBuildTimestamp) {
        deleteNetworkCaches();
      }
    });
})();`;
  return `${INJECT_MARKER_START}${manifestLink}<script>${script}</script>${INJECT_MARKER_END}`;
};

/** Remove a previously injected block, so re-running the CLI is idempotent. */
export const stripInjected = (html: string): string => {
  const start = html.indexOf(INJECT_MARKER_START);
  if (start === -1) return html;
  const end = html.indexOf(INJECT_MARKER_END);
  if (end === -1) return html;
  const afterEnd = end + INJECT_MARKER_END.length;
  // Also swallow the newline the injection added after the <head> tag.
  const trailing = html[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
  return (
    html.slice(0, start === 0 ? 0 : start - (html[start - 1] === "\n" ? 1 : 0)) +
    html.slice(trailing)
  );
};

/**
 * Insert `block` immediately after the opening `<head>` tag — before every
 * other script — replacing any block from a previous run.
 */
export const injectIntoHead = (html: string, block: string): string => {
  const cleaned = stripInjected(html);
  const headTag = /<head[^>]*>/i.exec(cleaned);
  if (!headTag) {
    throw new Error("[offline-postbuild] the built index.html has no <head> to inject into");
  }
  const insertAt = headTag.index + headTag[0].length;
  return `${cleaned.slice(0, insertAt)}\n${block}${cleaned.slice(insertAt)}`;
};
