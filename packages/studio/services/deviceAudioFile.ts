import type { AudioUploadTarget } from '@syra.fm/sdk';

/**
 * A picked file on the device's disk, PUT straight from there — the native half
 * of `directAudioUpload`, in `deviceAudioFile.native.ts`. On the web there is no
 * such file (the picker hands over a DOM `File`, which the SDK sends), so this
 * default answers `null` and the web bundle never carries `expo-file-system`.
 */
export interface DeviceAudioFile {
  /** The exact byte size — what the presigned PUT signs. */
  readonly size: number;
  put(target: AudioUploadTarget, onProgress?: (fraction: number) => void): Promise<void>;
}

export function deviceAudioFile(_uri: string): DeviceAudioFile | null {
  return null;
}
