/**
 * What Syra accepts as an audio upload — one definition, two controllers.
 *
 * `tracks.controller` (creator upload) and `uploads.controller` (listener locker
 * and public contribution) each construct their own multer instance, which is
 * right: they differ in field name, auth and what happens after the parse. What
 * they must NOT differ on is which files are allowed in and how big they may be,
 * and the day someone adds a format to one controller is the day the two silently
 * disagree about what Syra accepts.
 *
 * The mime allowlist and the mime→format mapping are the SAME object on purpose.
 * As two lists, adding a mime to the allowlist while forgetting the map is a
 * silent bug rather than a compile error: the file is accepted and then stored
 * under the wrong container format.
 */

import type { AudioFormat } from '@syra/shared-types';

/**
 * Upload cap. A 5-minute FLAC is around 30MB and a long lossless track can pass
 * 100MB, so the earlier 50MB ceiling rejected legitimate uploads.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Every mime type Syra accepts, mapped to the container format it is stored as.
 * Browsers and mobile pickers disagree about the spelling of several of these
 * (`audio/mp3` vs `audio/mpeg`, `audio/x-m4a` vs `audio/mp4`), so the aliases are
 * deliberate rather than redundant.
 */
export const AUDIO_MIME_FORMATS: Readonly<Record<string, AudioFormat>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/x-mpeg-3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** Whether an upload's declared mime type is one Syra accepts. */
export function isAllowedAudioMime(mimeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(AUDIO_MIME_FORMATS, mimeType);
}

/**
 * The container format for an accepted mime type.
 *
 * Returns `undefined` for anything not on the allowlist rather than defaulting —
 * a default here is how a rejected-by-policy file ends up stored as an mp3 it is
 * not. Callers should reject first with {@link isAllowedAudioMime}.
 */
export function audioFormatFor(mimeType: string): AudioFormat | undefined {
  return AUDIO_MIME_FORMATS[mimeType];
}

/** Shown to the user when the mime type is refused. */
export const AUDIO_UPLOAD_REJECTED_MESSAGE =
  'Invalid file type. Only audio files (mp3, flac, ogg, m4a, wav) are allowed.';
