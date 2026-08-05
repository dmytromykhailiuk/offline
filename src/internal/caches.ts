/** Drops every Cache Storage cache — the nuclear reset for a broken worker state. */
export const deleteAllCaches = async (): Promise<void> => {
  if (typeof caches === "undefined") return;
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
};
