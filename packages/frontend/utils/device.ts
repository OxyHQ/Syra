import type { DeviceType } from '@syra/shared-types';

/**
 * Map a React Native / Expo platform OS string to a Syra DeviceType.
 * Fallback for any unrecognized OS is 'web'.
 */
export function deviceTypeForPlatform(os: string): DeviceType {
  switch (os) {
    case 'ios':
    case 'android':
      return 'mobile';
    case 'web':
      return 'web';
    case 'macos':
    case 'windows':
      return 'desktop';
    default:
      return 'web';
  }
}

/**
 * Human-readable name for the current device based on its platform OS.
 * Deterministic — same OS always returns the same name.
 */
export function deviceDisplayName(os: string): string {
  switch (os) {
    case 'ios':
      return 'iPhone';
    case 'android':
      return 'Android';
    case 'macos':
      return 'Mac';
    case 'windows':
      return 'Windows';
    case 'web':
      return 'Web Player';
    default:
      return 'Web Player';
  }
}
