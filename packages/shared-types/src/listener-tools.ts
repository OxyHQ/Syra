import { z } from 'zod';
import { playlistSchema } from './playlist';
import { trackSchema } from './track';

const entityId = z.string().min(1).max(128);
export const curatedPlaylistSelectionSchema = z.object({
  playlistIds: z.array(entityId).max(10).refine((ids) => new Set(ids).size === ids.length),
});
export const curatedPlaylistsResponseSchema = z.object({ items: z.array(playlistSchema) });

/** Metadata only. No provider URL, credential, or audio file is imported. */
export const playlistImportEntrySchema = z.object({
  catalogId: entityId.optional(),
  isrc: z.string().trim().max(20).optional(),
  title: z.string().trim().max(300).optional(),
  artist: z.string().trim().max(300).optional(),
}).refine((entry) => Boolean(entry.catalogId || entry.isrc || (entry.title && entry.artist)));
export const playlistImportPreviewRequestSchema = z.object({ entries: z.array(playlistImportEntrySchema).min(1).max(500) });
export const playlistImportPreviewSchema = z.object({ items: z.array(z.object({
  index: z.number().int().nonnegative(),
  status: z.enum(['matched', 'missing', 'ambiguous']),
  track: trackSchema.nullable(),
})) });
export const playlistImportCommitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  trackIds: z.array(entityId).min(1).max(500),
  requestId: z.string().uuid(),
});
export const createdListenerPlaylistSchema = z.object({ playlistId: entityId });

export const mixConsentSchema = z.object({ consent: z.literal(true) });
export const mixJoinSchema = mixConsentSchema.extend({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const mixInviteSchema = z.object({ id: entityId, token: z.string(), expiresAt: z.string() });
export const mixListSchema = z.object({ items: z.array(z.object({
  id: entityId, playlistId: entityId.nullable(), expiresAt: z.string(),
})) });
export const releasePreferenceSchema = z.object({ enabled: z.boolean() });
export const downloadPolicySchema = z.object({ allowed: z.boolean(), canEdit: z.boolean() });
export const downloadPolicyUpdateSchema = z.object({ allowed: z.boolean() });
export const downloadGrantSchema = z.object({
  track: trackSchema,
  url: z.string().url(),
  downloadExpiresAt: z.string(),
  leaseExpiresAt: z.string(),
  byteLength: z.number().int().positive().max(100 * 1024 * 1024),
  extension: z.enum(['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac', 'opus', 'webm']),
});
export type PlaylistImportEntry = z.infer<typeof playlistImportEntrySchema>;
export type DownloadGrant = z.infer<typeof downloadGrantSchema>;
