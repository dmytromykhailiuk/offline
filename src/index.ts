/**
 * Full offline mode for SPAs. Two halves:
 *
 * - `offline-postbuild` (CLI) — run after every build: generates the service
 *   worker (`sw-min.js`), the precache manifest (`critical-assets.json`),
 *   a `build-timestamp.txt` and injects a bootstrap script into `index.html`.
 * - {@link OfflineTracker} (this entry) — registers the worker, warms the
 *   cache and reports whether the app is ready to work offline.
 */

export { OfflineTracker } from "./tracker";
export type {
  OfflineConfig,
  OfflineDataGroup,
  OfflineGlobalConfig,
  OfflineManifestDisplay,
  OfflineManifestIcon,
  OfflineStatus,
  OfflineTrackerListener,
  OfflineTrackerOptions,
  OfflineTrackerReInitOptions,
  OfflineTrackerUnsubscribe,
} from "./types";
