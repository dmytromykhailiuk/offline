import { describe, expectTypeOf, it } from "vitest";
import { OfflineTracker } from "../src/index";
import type {
  OfflineStatus,
  OfflineTrackerListener,
  OfflineTrackerOptions,
  OfflineTrackerReInitOptions,
  OfflineTrackerUnsubscribe,
} from "../src/index";

describe("types", () => {
  it("static members carry the documented signatures", () => {
    expectTypeOf(OfflineTracker.init).parameters.toEqualTypeOf<[OfflineTrackerOptions?]>();
    expectTypeOf(OfflineTracker.init).returns.toEqualTypeOf<void>();
    expectTypeOf(OfflineTracker.reInit).parameters.toEqualTypeOf<[OfflineTrackerReInitOptions?]>();
    expectTypeOf(OfflineTracker.reInit).returns.toEqualTypeOf<void>();
    expectTypeOf(OfflineTracker.registerServiceWorker).returns.toEqualTypeOf<void>();
    // Type-position typeof — the getters must not run before init().
    expectTypeOf<typeof OfflineTracker.status>().toEqualTypeOf<OfflineStatus>();
    expectTypeOf<typeof OfflineTracker.isOfflineReady>().toEqualTypeOf<boolean>();
    expectTypeOf(OfflineTracker.subscribe).parameter(0).toEqualTypeOf<OfflineTrackerListener>();
    expectTypeOf(OfflineTracker.subscribe).returns.toEqualTypeOf<OfflineTrackerUnsubscribe>();
    expectTypeOf(OfflineTracker.whenOfflineReady).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(OfflineTracker.stabilizeCaching).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(OfflineTracker.destroy).returns.toEqualTypeOf<void>();
  });

  it("options are all optional with precise shapes", () => {
    expectTypeOf<OfflineTrackerOptions["disabled"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<OfflineTrackerOptions["modifyRequestHeaders"]>().toEqualTypeOf<
      ((headers: Headers) => Headers) | undefined
    >();
    expectTypeOf<OfflineTrackerReInitOptions>().toEqualTypeOf<{
      additionalCriticalAssets?: string[];
      additionalLazyLoadAssets?: string[];
    }>();
    expectTypeOf<OfflineTrackerOptions["mapAssetUrl"]>().toEqualTypeOf<
      ((url: string) => string) | undefined
    >();
    expectTypeOf<OfflineTrackerOptions["shouldStabilize"]>().toEqualTypeOf<
      (() => boolean) | undefined
    >();
    expectTypeOf<OfflineTrackerOptions["additionalCriticalAssets"]>().toEqualTypeOf<
      string[] | undefined
    >();
    expectTypeOf<OfflineTrackerOptions["additionalLazyLoadAssets"]>().toEqualTypeOf<
      string[] | undefined
    >();
    expectTypeOf<OfflineStatus>().toEqualTypeOf<{
      criticalAssetsLoaded: boolean;
      lazyAssetsLoaded: boolean;
      allAssetsLoaded: boolean;
    }>();
  });

  it("the listener receives the readiness boolean", () => {
    expectTypeOf<OfflineTrackerListener>().toEqualTypeOf<(isOfflineReady: boolean) => void>();
    expectTypeOf<OfflineTrackerUnsubscribe>().toEqualTypeOf<() => void>();
  });

  it("cannot be constructed", () => {
    // @ts-expect-error — the constructor is private.
    void (() => new OfflineTracker());
  });
});
