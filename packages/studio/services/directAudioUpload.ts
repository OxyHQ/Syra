import { Platform } from 'react-native';
import { File as DeviceFile, UploadType } from 'expo-file-system';
import { z } from 'zod';
import { sendAudioUpload, type AudioUploadTarget } from '@syra.fm/sdk';
import { audioUploadTargetSchema, type AudioUploadPurpose } from '@syra/shared-types';
import { api } from '@/utils/api';

/**
 * Audio goes STRAIGHT to storage, never through the Syra API: the API refuses
 * any request body over 100 MB, and a track or locker file may be 200 MB and an
 * episode 500 MB. So an upload is: ask the API for a presigned PUT
 * (`POST /audio-uploads`, which signs the file's exact type and size), PUT the
 * bytes to storage with it (progress reported as they go), then call the route
 * that always took the file with `uploadId` in its place — that route answers
 * exactly as it did for a multipart file.
 */

const audioUploadTargetResponseSchema = z.object({ data: audioUploadTargetSchema });

/** The completing request's reference to the file, beside the route's own fields. */
export interface DirectAudioUploadReference {
  uploadId: string;
  fileName: string;
}

/** The file as the picker handed it over. */
export interface DirectAudioFile {
  uri: string;
  name: string;
  mimeType: string;
  /** Present on web when the picker returned a DOM `File`. */
  file?: File;
}

/**
 * Stream a file on the device to storage from disk — never into JavaScript
 * memory, which a 500 MB episode would not survive — the way the multipart
 * upload's `{ uri }` part did.
 */
async function putFromDevice(
  file: DeviceFile,
  target: AudioUploadTarget,
  onProgress?: (fraction: number) => void,
): Promise<void> {
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
}

/**
 * Send `audio` to storage for the route `purpose` names, and resolve with what
 * that route needs to complete the upload. `onProgress` receives the fraction of
 * bytes sent (0–1).
 */
export async function uploadAudioDirect(
  purpose: AudioUploadPurpose,
  audio: DirectAudioFile,
  onProgress?: (fraction: number) => void,
): Promise<DirectAudioUploadReference> {
  // Web: the picked File (or the blob its uri points at). Native: the file on
  // disk. Either way its exact size is known before asking — it is signed.
  const blob =
    Platform.OS === 'web' ? (audio.file ?? (await (await fetch(audio.uri)).blob())) : undefined;
  const deviceFile = blob ? undefined : new DeviceFile(audio.uri);
  const sizeBytes = blob ? blob.size : (deviceFile?.size ?? 0);

  const response = await api.post<unknown>('/audio-uploads', {
    purpose,
    mimeType: audio.mimeType,
    sizeBytes,
  });
  const parsed = audioUploadTargetResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(`Invalid upload target response: ${parsed.error.message}`);
  }
  const target = parsed.data.data;

  if (deviceFile) await putFromDevice(deviceFile, target, onProgress);
  else if (blob) await sendAudioUpload(target, blob, { onProgress });

  return { uploadId: target.uploadId, fileName: audio.name };
}
