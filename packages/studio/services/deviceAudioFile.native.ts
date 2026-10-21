import { File, UploadType } from 'expo-file-system';
import type { AudioUploadTarget } from '@syra.fm/sdk';
import type { DeviceAudioFile } from './deviceAudioFile';

/**
 * A picked file on disk, streamed to storage natively — never read into
 * JavaScript memory, which a 500 MB episode would not survive — the way the
 * multipart upload's `{ uri }` part was.
 */
export function deviceAudioFile(uri: string): DeviceAudioFile {
  const file = new File(uri);
  return {
    size: file.size,
    async put(target: AudioUploadTarget, onProgress?: (fraction: number) => void) {
      const result = await file.upload(target.url, {
        httpMethod: target.method,
        uploadType: UploadType.BINARY_CONTENT,
        headers: target.headers,
        onProgress: ({ bytesSent, totalBytes }) => {
          if (totalBytes > 0) onProgress?.(Math.min(1, bytesSent / totalBytes));
        },
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload to storage failed (${result.status})`);
      }
      onProgress?.(1);
    },
  };
}
