import { z } from 'zod';

/**
 * Direct audio uploads — the bytes go STRAIGHT to storage, never through the API.
 *
 * `api.syra.fm` sits behind a proxy that refuses any request body over 100 MB,
 * and Syra accepts audio up to 200 MB (a track, a locker file) and 500 MB (an
 * episode). So an upload is three requests, and only the middle one is large:
 *
 *   1. `POST /api/audio-uploads` (or, for a draft's ingest ticket,
 *      `POST /api/podcasts/episodes/:id/ingest/upload`) — the API answers with an
 *      {@link AudioUploadTarget}: a short-lived presigned PUT that admits ONE
 *      object of exactly the declared type and size (both are signed headers).
 *   2. The client PUTs the file's raw bytes to `url` with `headers`. Storage
 *      refuses any other length or type itself; the API never sees the bytes.
 *   3. The client calls the route it always called (`POST /api/tracks/upload`,
 *      `POST /api/uploads`, `POST /api/podcasts/:id/episodes`,
 *      `POST /api/podcasts/episodes/:id/ingest`) with a JSON body carrying
 *      `uploadId` instead of a file. That route runs exactly what it ran on a
 *      multipart file, and answers exactly as it did.
 */

/** Which route the upload will be completed by — it decides the size cap. */
export const AUDIO_UPLOAD_PURPOSES = ['track', 'locker', 'episode'] as const;
export const audioUploadPurposeSchema = z.enum(AUDIO_UPLOAD_PURPOSES);
export type AudioUploadPurpose = z.infer<typeof audioUploadPurposeSchema>;

/**
 * Step 1's body. `sizeBytes` is the file's exact size: it is signed into the
 * URL, so storage takes a body of that length and no other, and a size over the
 * route's cap is refused before anything is transferred.
 */
export const createAudioUploadRequestSchema = z.object({
  purpose: audioUploadPurposeSchema,
  mimeType: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().positive(),
});
export type CreateAudioUploadRequest = z.infer<typeof createAudioUploadRequestSchema>;

/** The ticket-authenticated twin of step 1: the purpose is always an episode. */
export const createEpisodeIngestUploadRequestSchema = createAudioUploadRequestSchema.omit({
  purpose: true,
});
export type CreateEpisodeIngestUploadRequest = z.infer<
  typeof createEpisodeIngestUploadRequestSchema
>;

/** Step 1's answer: where, and with which headers, to PUT the file. */
export const audioUploadTargetSchema = z.object({
  uploadId: z.string(),
  url: z.string(),
  method: z.literal('PUT'),
  /** Send exactly these (the signed `Content-Type`); the body sets its own length. */
  headers: z.record(z.string(), z.string()),
  maxBytes: z.number().int().positive(),
  expiresAt: z.string(),
});
export type AudioUploadTarget = z.infer<typeof audioUploadTargetSchema>;

/**
 * What step 3 adds to a route's own fields. `fileName` is the name the file had
 * on the uploader's device — the locker titles an untagged file from it, which a
 * multipart upload carried as the part's filename.
 */
export const audioUploadReferenceSchema = z.object({
  uploadId: z.string().uuid(),
  fileName: z.string().max(1024).optional(),
});
export type AudioUploadReference = z.infer<typeof audioUploadReferenceSchema>;
