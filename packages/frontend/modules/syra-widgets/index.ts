import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class SyraWidgetsNativeModule extends NativeModule {
  refreshLiveRooms(): Promise<void>;
}

/**
 * The widget owns its own fetch, store, schedule and render natively, because it
 * runs in the launcher's process with no JS runtime to call into. So the entire
 * JS surface is one nudge: somewhere the app already knows the live-room list
 * just changed, it can ask the widget to catch up rather than wait for its next
 * tick.
 *
 * `requireOptionalNativeModule` rather than `requireNativeModule` because
 * `packages/frontend/android` is CNG-generated and gitignored — a build that has
 * not prebuilt, and every web build, has no native module here at all. Tolerating
 * that once, in this file, keeps every call site free of the check.
 */
const nativeModule = requireOptionalNativeModule<SyraWidgetsNativeModule>('SyraWidgets');

export const areHomeScreenWidgetsAvailable = nativeModule !== null;

export function refreshLiveRoomsWidget(): Promise<void> {
  return nativeModule?.refreshLiveRooms() ?? Promise.resolve();
}
