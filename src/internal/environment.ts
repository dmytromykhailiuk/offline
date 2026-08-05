import type { OfflineGlobalConfig } from "../types";

export const hasWindow = (): boolean => typeof window !== "undefined";

export const hasServiceWorker = (): boolean =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator;

/** The global injected into `index.html` by `offline-postbuild`. */
export const readOfflineGlobalConfig = (): OfflineGlobalConfig | undefined =>
  hasWindow() ? window.__OFFLINE_CONFIG__ : undefined;

/**
 * `"client"` / `"/client/"` / `"/client"` all mean
 * the same prefix; `""` and `"/"` mean none. Normalized to either `""` or
 * `"/<path>"` so it can be glued between the origin and a pathname.
 */
export const normalizeDeploymentPath = (value: string): string => {
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `/${trimmed}`;
};

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
