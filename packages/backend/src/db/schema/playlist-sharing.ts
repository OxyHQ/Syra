import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { playlists } from './library';

/** Bearer grants are stored as SHA-256 digests; raw tokens leave only at creation. */
export const playlistInvites = pgTable('playlist_invites', {
  id: generatedId(),
  playlistId: text().notNull().references(() => playlists.id, { onDelete: 'cascade' }),
  tokenHash: text().notNull(),
  role: text({ enum: ['editor', 'viewer'] }).notNull(),
  issuedBy: text().notNull(),
  expiresAt: timestamptz().notNull(),
  createdAt: createdAt(),
}, (table) => [
  unique('playlist_invites_token_hash_key').on(table.tokenHash),
  index('playlist_invites_playlist_id_idx').on(table.playlistId),
  check('playlist_invites_role_check', sql`${table.role} in ('editor', 'viewer')`),
]);

/** Private, bounded audit reads. A deleted playlist cascades its activity. */
export const playlistActivity = pgTable('playlist_activity', {
  id: generatedId(),
  playlistId: text().notNull().references(() => playlists.id, { onDelete: 'cascade' }),
  actorOxyUserId: text().notNull(),
  action: text({ enum: ['tracks_added', 'tracks_removed', 'tracks_reordered', 'member_joined', 'member_removed', 'role_changed', 'invites_revoked'] }).notNull(),
  targetOxyUserId: text(),
  createdAt: createdAt(),
}, (table) => [
  index('playlist_activity_playlist_created_idx').on(table.playlistId, table.createdAt.desc()),
  check('playlist_activity_action_check', sql`${table.action} in ('tracks_added', 'tracks_removed', 'tracks_reordered', 'member_joined', 'member_removed', 'role_changed', 'invites_revoked')`),
]);
