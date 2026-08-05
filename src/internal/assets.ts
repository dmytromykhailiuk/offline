/**
 * Asks the service worker whether each asset is already cached, via the
 * `X-Cache-Only` header the generated worker understands (it responds from
 * the cache or fails the request without touching the network). Maintains
 * `notCached` as the source of truth for what still needs loading.
 * An empty list is trivially loaded.
 */
export const checkAssets = async (
  assets: string[],
  notCached: Set<string>,
  fetchFn: typeof fetch,
): Promise<boolean> => {
  if (assets.length === 0) return true;
  const results = await Promise.all(
    assets.map((asset) =>
      fetchFn(asset, { headers: { "X-Cache-Only": "true" } })
        .then((response) => response.ok)
        .catch(() => false)
        .then((isCached) => {
          if (isCached) notCached.delete(asset);
          else notCached.add(asset);
          return isCached;
        }),
    ),
  );
  return results.every(Boolean);
};

/**
 * One load attempt per asset — a plain fetch the service worker intercepts
 * and caches. Failures are fine: the caller's check/retry loop is the
 * authority on what is cached and drives the next attempt.
 */
export const loadAssets = async (assets: string[], fetchFn: typeof fetch): Promise<void> => {
  await Promise.all(assets.map((asset) => fetchFn(asset).catch(() => null)));
};
