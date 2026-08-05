import { NetworkConnection } from "@dmytromykhailiuk/network-connection";

/**
 * `NetworkConnection` throws on every member until its `init()` runs — the
 * only way to ask "is it initialized?" without private access is to poke it.
 */
export const isNetworkConnectionInitialized = (): boolean => {
  try {
    void NetworkConnection.isOnline;
    return true;
  } catch {
    return false;
  }
};

/** `NetworkConnection.isOnline` that reports `false` instead of throwing after a destroy. */
export const isNetworkOnline = (): boolean => {
  try {
    return NetworkConnection.isOnline;
  } catch {
    return false;
  }
};
