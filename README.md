# @dmytromykhailiuk/offline

Full offline mode for SPAs. One post-build command generates the service worker, the precache
manifest and a bootstrap script; one **static-only, promise-based** `OfflineTracker` class
registers the worker, warms the cache and answers precisely: _is this app ready to work offline?_

> **Full documentation:** open [Docs](https://dmytromykhailiuk.github.io/offline/) in a browser —
> every option, with examples, a table of contents and cross-links. This README is the short form.

> ⚠️ **Hard precondition:** `OfflineTracker` consumes
> [@dmytromykhailiuk/network-connection](https://github.com/dmytromykhailiuk/network-connection)
> for every online/offline decision and **never initializes it on its own** — the app owns that
> singleton. `OfflineTracker.init()` throws immediately when `NetworkConnection.init()` has not
> been called first.

The work happens in the two places it belongs. At **build time**, the `offline-postbuild` CLI
reads `offline.json`, collects the build's files by pattern, generates `sw-min.js` +
`critical-assets.json` + `build-timestamp.txt`, and injects a bootstrap script into `index.html`
(idempotently — re-runs replace, never stack). At **runtime**, `OfflineTracker` probes the cache
asset by asset through the worker's `X-Cache-Only` protocol, loads what is missing, retries on an
interval, parks while offline and resumes on reconnect — reporting readiness as a boolean, a
subscription and a promise. No rxjs, no signals — plain TypeScript and promises.

## Install

```sh
npm i @dmytromykhailiuk/offline @dmytromykhailiuk/network-connection
```

## Quick start

**1.** Describe the offline layer in `offline.json`:

```json
{
  "name": "Client",
  "buildPath": "/dist",
  "themeColor": "#1c1c1c",
  "icons": [
    { "src": "icons/icon-192x192.png", "sizes": "192x192", "type": "image/png" }
  ],
  "criticalAssets": ["**.js", "**.css", "**.svg", "/images/logo.png"],
  "lazyLoadAssets": ["/images/*.jpg"],
  "dataGroups": [
    { "name": "translations", "urls": ["/translations/"], "maxSize": 1 }
  ]
}
```

Every run also generates `manifest.webmanifest` from the flat fields `name` (required),
`shortName`, `themeColor`, `backgroundColor`, `display`
(`"standalone" | "fullscreen" | "minimal-ui" | "browser"`, default `"standalone"`) and `icons`,
and links it from the injected `<head>` block — the app is installable with zero extra steps.
camelCase keys map to the spec's snake_case; the manifest's `scope`/`start_url` are not options —
both derive from `deploymentPath`.

**2.** Run the CLI after every build:

```json
{
  "scripts": {
    "postbuild": "offline-postbuild"
  }
}
```

**3.** Wire the runtime at startup — here with a blocking screen while the connection is down and
the app is not yet ready to work offline:

```ts
import { NetworkConnection } from "@dmytromykhailiuk/network-connection";
import { OfflineTracker } from "@dmytromykhailiuk/offline";

await NetworkConnection.init("/health.txt");

OfflineTracker.init({ disabled: import.meta.env.DEV });
OfflineTracker.registerServiceWorker();

const networkUnsubscribeFn = NetworkConnection.subscribe((isOnline) => {
  if (
    !isOnline &&
    !OfflineTracker.isOfflineReady &&
    !NetworkBlockingScreen.isVisible()
  ) {
    NetworkBlockingScreen.show();
  }

  if (isOnline && NetworkBlockingScreen.isVisible()) {
    NetworkBlockingScreen.hide();
  }
});

OfflineTracker.whenOfflineReady().then(() => networkUnsubscribeFn());
```

`init()` only kicks the process off — readiness is asynchronous. A repeat visit — online or
offline — initializes from the cached `critical-assets.json` (a client-side cache-first bucket
via `@dmytromykhailiuk/cache-request`, invalidated by the bootstrap's new-build cache wipe); only
a first-ever offline visit has nothing to fall back on, so the cache warms up once the connection
appears. Follow the progress through `subscribe()`, `whenOfflineReady()` and `isOfflineReady` —
and when new assets arrive with data, `OfflineTracker.reInit({ additionalCriticalAssets })` merges
them in and restarts tracking.

## The API at a glance

```ts
class OfflineTracker {
  static init(options?: OfflineTrackerOptions): void; // sync — kicks everything off; once
  static reInit(options?: OfflineTrackerReInitOptions): void; // restart tracking, merge assets
  static registerServiceWorker(): void; // no args, callable any time
  static get status(): OfflineStatus;
  static get isOfflineReady(): boolean;
  static subscribe(
    listener: (isOfflineReady: boolean) => void
  ): OfflineTrackerUnsubscribe;
  static whenOfflineReady(): Promise<void>;
  static stabilizeCaching(): Promise<void>;
  static destroy(): void; // tests / HMR
}
```

The constructor is private and throws — there is exactly one offline state per app. Every
stateful member throws before `init()`; the exceptions are `registerServiceWorker()`
(deliberately independent) and `destroy()` (safe no-op).

`init()` is callable **once** (a second call throws) and its options are: `disabled` (dev
environments — the tracker initializes inert, skips even the `NetworkConnection` precondition,
and `isOfflineReady` stays `false`), `additionalCriticalAssets` / `additionalLazyLoadAssets`
(extra assets on top of the built list; lazy ones load in the background and gate
`isOfflineReady` without blocking the critical set), `modifyRequestHeaders` (called before every
request the tracker makes with a `Headers` instance, returns the `Headers` to send — attach an
auth token; the headers analog of `mapAssetUrl`),
`mapAssetUrl` (versioned paths), `shouldStabilize` (skip auto-repair on some routes),
`swSettleDelay` / `retryDelay` / `reconnectSettleDelay` timings. The deployment path and the
list URL are not options — both derive from the `window.__OFFLINE_CONFIG__` global the CLI
injected. `critical-assets.json` goes through a cache-first client bucket
(`@dmytromykhailiuk/cache-request`, bucket `offline-critical-assets`): the cached copy is served
when present — no network round-trip per session — and the bootstrap's new-build cache wipe is
what invalidates it. With no cached copy the fetch is retried until an ok response arrives — the
CLI always generates it, so a 404/5xx is transient deploy state; offline stretches are waited out
via `NetworkConnection.continueWhenOnline()`.

`reInit()` **restarts tracking and merges assets** — its only options are the two asset lists.
The previous cycle is superseded and the new one tracks the deduplicated union of everything
passed to `init()` and every `reInit()` so far — a later call can never drop what an earlier one
declared critical. The configuration is fixed by `init()`; `critical-assets.json` is never
refetched. A service worker `controllerchange` restarts tracking with the accumulated union
automatically.

`stabilizeCaching()` — the repair path. No controlling worker → every cache is deleted and the
page reloads; healthy worker → one load-and-recheck round for the still-missing assets. Runs
automatically on reconnect while not ready (gated by `shouldStabilize`).

## The generated worker

First match wins: requests with `X-Cache-Only: true` are answered from the cache or failed
(never sent to the network — that's the tracker's probe); SPA routes are served network-first
with the cached `index.html`; listed assets cache-first; `dataGroups` requests — matched by url
prefixes and/or `criticalAssets`-style glob `patterns` — cache-first into named caches with
optional `maxSize` eviction. The injected bootstrap fixes the `/app` → `/app/` worker
scope, reloads once after a `ChunkLoadError` when the connection returns, and clears every cache
when `build-timestamp.txt` reveals a new build.

## TypeScript

Everything is typed; ESM + CJS with `.d.ts` for both. Exported types: `OfflineTrackerOptions` ·
`OfflineTrackerReInitOptions` · `OfflineStatus` · `OfflineTrackerListener` ·
`OfflineTrackerUnsubscribe` ·
`OfflineGlobalConfig` · `OfflineConfig` · `OfflineDataGroup` · `OfflineManifestDisplay` ·
`OfflineManifestIcon`.

## License

MIT
