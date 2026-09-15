import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { catalogEntities, tracks } from './catalog';
import { playlists } from './library';

/** Explicit creator choices, never inferred from playlist contents. */
export const artistCuratedPlaylists = pgTable('artist_curated_playlists', {
  id: generatedId(),
  artistId: text().notNull().references(() => catalogEntities.id, { onDelete: 'cascade' }),
  playlistId: text().notNull().references(() => playlists.id, { onDelete: 'cascade' }),
  position: integer().notNull(),
}, (table) => [
  unique('artist_curated_playlists_artist_playlist_key').on(table.artistId, table.playlistId),
  unique('artist_curated_playlists_artist_position_key').on(table.artistId, table.position),
  index('artist_curated_playlists_playlist_id_idx').on(table.playlistId),
  check('artist_curated_playlists_position_check', sql`${table.position} between 0 and 9`),
]);

/** One-shot, two-person consent. No public read ever returns the token digest. */
export const tasteMixes = pgTable('taste_mixes', {
  id: generatedId(),
  hostOxyUserId: text().notNull(),
  hostUsername: text().notNull(),
  guestOxyUserId: text(),
  tokenHash: text().notNull(),
  playlistId: text().references(() => playlists.id, { onDelete: 'set null' }),
  expiresAt: timestamptz().notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique('taste_mixes_token_hash_key').on(table.tokenHash),
  index('taste_mixes_host_idx').on(table.hostOxyUserId),
  index('taste_mixes_guest_idx').on(table.guestOxyUserId),
  index('taste_mixes_playlist_idx').on(table.playlistId),
  index('taste_mixes_expires_idx').on(table.expiresAt),
  check('taste_mixes_different_people_check', sql`${table.guestOxyUserId} is null or ${table.guestOxyUserId} <> ${table.hostOxyUserId}`),
]);

/** Repeated import confirmation creates the same playlist, not duplicates. */
export const playlistImportReceipts = pgTable('playlist_import_receipts', {
  id: generatedId(),
  oxyUserId: text().notNull(),
  requestId: text().notNull(),
  requestHash: text().notNull(),
  playlistId: text().notNull().references(() => playlists.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (table) => [
  unique('playlist_import_receipts_user_request_key').on(table.oxyUserId, table.requestId),
  index('playlist_import_receipts_playlist_idx').on(table.playlistId),
]);

/** Absent means no download permission. Only the claimed artist can opt in. */
export const trackDownloadPolicies = pgTable('track_download_policies', {
  trackId: text().primaryKey().references(() => tracks.id, { onDelete: 'cascade' }),
  allowed: boolean().notNull().default(false),
  updatedAt: updatedAt(),
});
