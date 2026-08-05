/** The shape data groups take inside the generated worker. */
interface WorkerDataGroup {
  name: string;
  /** Pathname prefixes, already prefixed with `deploymentPath`. */
  urls: string[];
  /**
   * RegExp sources, compiled at build time (by the same `compilePattern` as
   * `criticalAssets`) from the config's glob patterns — the worker only
   * instantiates them.
   */
  patterns: string[];
  maxSize?: number;
}

/**
 * The service worker source, with `__OFFLINE_*__` tokens standing in for the
 * config values. Kept as plain JS (no template literals) so it can live
 * inside this template string untouched and needs no transpilation — esbuild
 * only minifies it.
 *
 * Deliberate deviations from the original hand-written worker:
 * - the auth header key honors the `authHeaderPath` config instead of a
 *   hardcoded `Authorization`;
 * - `dataGroups[].urls` arrive already prefixed with `deploymentPath` (done
 *   at generation time), otherwise they could never match under a non-root
 *   deployment;
 * - `dataGroups[].patterns` arrive as build-time-compiled RegExp sources;
 *   a request belongs to a group when its pathname starts with any of the
 *   group's `urls` OR matches any of its `patterns`.
 */
const WORKER_TEMPLATE = `"use strict";

var indexPath = __OFFLINE_INDEX_PATH__;
var spaRoutesPaths = __OFFLINE_SPA_ROUTES_PATHS__;
var deploymentPath = __OFFLINE_DEPLOYMENT_PATH__;
var authHeader = __OFFLINE_AUTH_HEADER__;
var dataGroups = __OFFLINE_DATA_GROUPS__;
var criticalAssets = __OFFLINE_CRITICAL_ASSETS__;
var lazyLoadAssets = __OFFLINE_LAZY_LOAD_ASSETS__;

var INDEX_CACHE_NAME = "custom-index-cache";
var ASSETS_CACHE_NAME = "assets-cache";

var allAssets = criticalAssets.concat(lazyLoadAssets);

dataGroups.forEach(function (group) {
  group.compiledPatterns = group.patterns.map(function (source) {
    return new RegExp(source);
  });
});

function joinPaths() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var part = String(arguments[i] == null ? "" : arguments[i]).replace(/^\\/|\\/$/g, "");
    if (part) parts.push(part);
  }
  return parts.join("/");
}

function fetchFromServer(resource, token) {
  var headers = { "Cache-Control": "no-cache" };
  if (token) headers[authHeader] = token;
  return fetch(resource, { method: "GET", headers: headers, cache: "no-store" });
}

function enforceMaxSize(cacheName, maxSize) {
  if (!maxSize || maxSize === Infinity) return Promise.resolve();
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= maxSize) return undefined;
      return cache.delete(keys[0]).then(function () {
        return enforceMaxSize(cacheName, maxSize);
      });
    });
  });
}

function matchDataGroup(pathname) {
  return dataGroups.find(function (group) {
    return (
      group.urls.some(function (prefix) {
        return pathname.startsWith(prefix);
      }) ||
      group.compiledPatterns.some(function (regexp) {
        return regexp.test(pathname);
      })
    );
  });
}

function getRequestOnlyFromCache(cacheName, pathname) {
  if (!cacheName || !pathname) {
    return Response.error();
  }
  return caches.open(cacheName).then(function (cache) {
    return cache.match(pathname).then(function (cachedResp) {
      if (cachedResp) {
        return cachedResp.clone();
      }
      return Response.error();
    });
  });
}

function networkFirst(pathname, cacheName, token) {
  return fetchFromServer(pathname, token)
    .then(function (resp) {
      if (resp && resp.ok && resp.status < 400) {
        return caches.open(cacheName).then(function (cache) {
          return cache.put(pathname, resp.clone()).then(function () {
            return resp;
          });
        });
      }
      throw new Error("Bad response!");
    })
    .catch(function () {
      return getRequestOnlyFromCache(cacheName, pathname);
    });
}

function cacheFirst(pathname, cacheName, token, maxCacheSize) {
  return caches.open(cacheName).then(function (cache) {
    return cache.match(pathname).then(function (cachedResp) {
      if (cachedResp) {
        return cachedResp.clone();
      }
      return fetchFromServer(pathname, token)
        .then(function (resp) {
          if (resp && resp.ok && resp.status < 400) {
            return cache
              .put(pathname, resp.clone())
              .then(function () {
                return enforceMaxSize(cacheName, maxCacheSize || null);
              })
              .then(function () {
                return resp;
              });
          }
          return resp;
        })
        .catch(function () {
          return cachedResp || Response.error();
        });
    });
  });
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  var token = event.request.headers.get(authHeader);
  var cacheOnly = event.request.headers.get("X-Cache-Only") === "true";
  var isSpaRoute = Boolean(
    spaRoutesPaths.some(function (spaRoutesPath) {
      return url.pathname.startsWith("/" + joinPaths(deploymentPath, spaRoutesPath));
    }) ||
      url.pathname === "/" + joinPaths(deploymentPath, "") + "/" ||
      url.pathname === "/" + joinPaths(deploymentPath, "") ||
      url.pathname === "/" + joinPaths(deploymentPath, indexPath),
  );
  var isAsset = allAssets.indexOf(url.pathname) !== -1;
  var matchedGroup = matchDataGroup(url.pathname);

  if (cacheOnly) {
    var cacheName = isSpaRoute
      ? INDEX_CACHE_NAME
      : isAsset
        ? ASSETS_CACHE_NAME
        : matchedGroup
          ? "data-group-" + matchedGroup.name
          : null;
    var pathname = isSpaRoute ? "/" + joinPaths(deploymentPath, indexPath) : url.pathname;
    event.respondWith(getRequestOnlyFromCache(cacheName, pathname));
    return;
  }

  if (isSpaRoute) {
    event.respondWith(
      networkFirst("/" + joinPaths(deploymentPath, indexPath), INDEX_CACHE_NAME, token),
    );
    return;
  }

  if (isAsset) {
    event.respondWith(cacheFirst(url.pathname, ASSETS_CACHE_NAME, token));
    return;
  }

  if (matchedGroup) {
    event.respondWith(
      cacheFirst(url.pathname, "data-group-" + matchedGroup.name, token, matchedGroup.maxSize),
    );
  }
});
`;

export interface WorkerTemplateVariables {
  indexPath: string;
  spaRoutesPaths: string[];
  deploymentPath: string;
  authHeader: string;
  dataGroups: WorkerDataGroup[];
  criticalAssets: string[];
  lazyLoadAssets: string[];
}

// split/join instead of String#replaceAll — the lib target is ES2020, and a
// JSON-stringified value must not be re-scanned for `$`-patterns anyway.
const substitute = (source: string, token: string, value: unknown): string =>
  source.split(token).join(JSON.stringify(value));

/**
 * Substitute every `__OFFLINE_*__` token with its JSON-serialized value —
 * injection-safe for strings, arrays and objects alike.
 */
export const buildServiceWorkerSource = (variables: WorkerTemplateVariables): string => {
  let source = WORKER_TEMPLATE;
  source = substitute(source, "__OFFLINE_INDEX_PATH__", variables.indexPath);
  source = substitute(source, "__OFFLINE_SPA_ROUTES_PATHS__", variables.spaRoutesPaths);
  source = substitute(source, "__OFFLINE_DEPLOYMENT_PATH__", variables.deploymentPath);
  source = substitute(source, "__OFFLINE_AUTH_HEADER__", variables.authHeader);
  source = substitute(source, "__OFFLINE_DATA_GROUPS__", variables.dataGroups);
  source = substitute(source, "__OFFLINE_CRITICAL_ASSETS__", variables.criticalAssets);
  source = substitute(source, "__OFFLINE_LAZY_LOAD_ASSETS__", variables.lazyLoadAssets);
  return source;
};
