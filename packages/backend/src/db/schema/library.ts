/**
 * Library and playlist schema — `playlists` and everything that belongs to
 * it, plus the five junction tables that replace `UserLibrary`, plus the
 * three small per-user/per-device tables (`recently_played`,
 * `playback_states`, `devices`).
 *
 * Ported from `packages/backend/src/models/{Library,Playlist,PlaylistTrack,
 * RecentlyPlayed,PlaybackState,Device}.ts`, field by field, against
 * `packages/backend/docs/db/RELATIONS.md` for every foreign key.
 *
 * ## `Library` ceases to exist
 *
 * `UserLibrary` (`models/Library.ts`) was five arrays on one document —
 * `likedTracks`, `savedAlbums`, `followedArtists`, `savedPlaylists`,
 * `subscribedPodcasts` — plus the `oxyUserId` that owned them. With the
 * arrays gone as real junction tables (`userLikedTracks`, `userSavedAlbums`,
 * `userFollowedArtists`, `userSavedPlaylists`, `userPodcastSubscriptions`,
 * each `(oxy_user_id, target_id)`, unique), the document has nothing left in
 * it — it was only ever a container Mongo forced on a set of independent
 * many-to-many relations. RELATIONS.md classifies all five as `CASCADE
 * (target-side)`: `$addToSet`/`$pull` in `controllers/library.controller.ts`
 * already treat each array as an idempotent SET, which the `unique(oxy_user_id,
 * *_id)` constraint on every junction below enforces for real rather than by
 * convention.
 *
 * `userSavedPlaylists.playlistId` is the one relation of the five whose
 * CASCADE actually fires in production: playlists ARE hard-deleted
 * (`controllers/playlists.controller.ts:383`), and RELATIONS.md documents
 * that the app cleans up `PlaylistTrack` on delete but never
 * `Library.savedPlaylists` — a real orphan today (verified live: see
 * `__tests__/gates.test.ts`'s "cascades a deleted playlist" test) that this
 * table's `.references(() => playlists.id, { onDelete: 'cascade' })` fixes at
 * the database level with no application change.
 *
 * `userPodcastSubscriptions.podcastId` references `podcasts` (Task 4,
 * `schema/podcasts.ts`) — CASCADE, matching `RELATIONS.md`'s
 * `Library.subscribedPodcasts[] -> podcasts` entry. It also keeps its own
 * standalone index regardless of the FK, because `services/notifications/
 * triggers/episodePublished.ts:50` reverse-joins it (`find({
 * subscribedPodcasts: episode.podcastId })`, fan-out to every subscriber on a
 * new episode) — the one junction of the five with a real reverse-read, not
 * just the forward "this user's list" one every `unique(oxy_user_id, *_id)`
 * already serves as a leading-column index.
 *
 * ## `Playlist.sources[]` — the fourth sibling
 *
 * `models/Playlist.ts:27,66` carries the identical `SourceProvenanceSchema`
 * `catalog.ts` already gave `track_sources`/`album_sources`/
 * `catalog_entity_sources` — flagged in Task 2's own report as a gap in its
 * brief, not a deliberate exclusion. `playlist_sources` is the fourth and
 * last of that family, same shape, no jsonb special case.
 *
 * ## `Playlist.collaborators[]` — a child table with no observed writer
 *
 * `controllers/playlists.controller.ts` reads `playlist.collaborators` (the
 * `$or` in `getUserPlaylists`, the `.find()` in the internal edit-permission
 * helper) and `utils/catalogVisibility.ts`'s `canViewPlaylist` reads it too,
 * but nothing in this codebase ever writes to it — no route, no controller,
 * no script assigns `playlist.collaborators`: a shipped read half of a
 * mechanism whose write half was never connected. (Task 2's report cited
 * `CatalogEntity.members[]` as the same shape; it is NOT — `members` is written
 * by `services/uploads/enrichCatalogEntity.ts`, measured in Task 10b. The
 * comparison is dropped; the grep for `playlist.collaborators` stands on its
 * own.) RELATIONS.md still names it a real FK
 * relation (`Playlist.collaborators[].oxyUserId`, CROSS-SERVICE) and the
 * brief names it explicitly as a child table, so it is built as one —
 * `playlist_collaborators`, indexed BOTH directions: `unique(playlist_id,
 * oxy_user_id)` for "is this user a collaborator here" and a standalone
 * `oxy_user_id` index for the reverse `getUserPlaylists` direction, which the
 * leading-column unique index does not serve.
 *
 * ## `PlaybackState.activeDeviceId` stays unconstrained — a deviation from a
 * literal reading of RELATIONS.md, with the reason spelled out
 *
 * RELATIONS.md notes the real target is the COMPOUND `(oxy_user_id,
 * device_id)` key on `devices`, not `devices.id`, and recommends `SET NULL`.
 * A composite `.references()` expressing that is possible in drizzle-orm
 * (`foreignKey({ columns, foreignColumns })`), but `ON DELETE SET NULL` on a
 * composite FK nulls EVERY referencing column together — there is no typed
 * API in drizzle-orm 0.45.2 for Postgres 15's per-column `SET NULL
 * (column_list)` form. That would try to null `playback_states.oxy_user_id`
 * too, which is NOT NULL and unique on this very table — the constraint
 * would be broken by construction, not just awkward. Left as a plain,
 * unconstrained column instead (ledger entry in `deferredForeignKeys.ts`);
 * see that entry for the full reasoning. This is the "if you think a row is
 * wrong, say so" case the brief calls out, not a silent substitution.
 *
 * ## `PlaybackState.queue[]` / `Device.capabilities[]` stay arrays
 *
 * Per the brief: both are read whole and never queried by element, so a
 * child table would be over-normalization. `text[]`, same
 * `.notNull().default(sql\`array[]::text[]\`)` treatment as `catalog.ts`'s
 * array columns (`genres`, `aliases`, `tags`, …).
 *
 * ## `order` becomes `position`
 *
 * `PlaylistTrack.order` is renamed `position` here, matching every other
 * ordinal child table this schema already has (`track_credits.position`,
 * `track_sources.position`, `album_sources.position`,
 * `catalog_entity_sources.position`, `lyrics_lines.position`,
 * `musicbrainz_artist_urls.position`) — `order` is also a reserved SQL
 * keyword. A schema-wide naming decision, not a Mongo field this port is
 * required to preserve verbatim.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import { albums, CATALOG_SOURCES, catalogEntities, imageAssets, PROVENANCE_PROVIDERS, tracks } from './catalog';
import { podcasts } from './podcasts';

// ── Closed value sets ────────────────────────────────────────────────────
// Same convention as catalog.ts: one `as const` tuple per closed value set,
// used both to type the column and to derive its CHECK.

/** `@syra/shared-types` `playlistVisibilitySchema`. */
export const PLAYLIST_VISIBILITIES = ['public', 'private', 'unlisted'] as const;

/** `@syra/shared-types` `playlistCollaboratorSchema`'s `role`. */
export const PLAYLIST_COLLABORATOR_ROLES = ['owner', 'editor', 'viewer'] as const;

/** `@syra/shared-types` `deviceTypeSchema`. */
export const DEVICE_TYPES = ['web', 'mobile', 'desktop', 'speaker'] as const;

/** `models/PlaybackState.ts` `IPlaybackState.repeat`. */
export const PLAYBACK_REPEAT_MODES = ['off', 'all', 'one'] as const;

// ── playlists ─────────────────────────────────────────────────────────────

export const playlists = pgTable(
  'playlists',
  {
    id: generatedId(),
    name: text().notNull(),
    description: text(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),
    ownerUsername: text().notNull(),
    coverArtId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    visibility: text({ enum: PLAYLIST_VISIBILITIES }).notNull().default('private'),
    trackCount: integer().notNull().default(0),
    totalDuration: doublePrecision().notNull().default(0),
    followers: integer().notNull().default(0),
    primaryColor: text(),
    secondaryColor: text(),
    source: text({ enum: CATALOG_SOURCES }),
    externalIsrc: text(),
    // The provenance LOG is `playlist_sources` (child table, below) — the
    // fourth sibling of `track_sources`/`album_sources`/
    // `catalog_entity_sources`. See the file-level doc comment.
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', name || ' ' || coalesce(description, ''))`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('playlists_visibility_check', sql`${t.visibility} in (${sql.raw(inList(PLAYLIST_VISIBILITIES))})`),
    check(
      'playlists_source_check',
      sql`${t.source} is null or ${t.source} in (${sql.raw(inList(CATALOG_SOURCES))})`
    ),
    index('playlists_owner_oxy_user_id_created_at_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    /**
     * Replaces Mongo's standalone `{ visibility: 1, followers: -1 }` index.
     * `browse.controller.ts`'s made-for-you and discover sections both query
     * `{ visibility: PlaylistVisibility.PUBLIC }` sorted `{ followers: -1,
     * createdAt: -1 }` and NEVER browse any other visibility — the same "port
     * what the real query needs, partial on the predicate it actually filters
     * on" decision Task 2 made for `tracks`' playability indexes.
     */
    index('playlists_public_followers_idx')
      .on(t.followers.desc(), t.createdAt.desc())
      .where(sql`${t.visibility} = 'public'`),
    index('playlists_search_gin').using('gin', t.searchVector),
  ]
);

// ── playlist_tracks ──────────────────────────────────────────────────────

export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id: generatedId(),
    playlistId: text()
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** `new Date().toISOString()` at the one call site — a real instant. */
    addedAt: timestamptz().notNull(),
    /** An Oxy account id — no foreign key. Not `*_id`-suffixed. */
    addedBy: text(),
    /** `Mongo`'s `order` — renamed; see the file-level doc comment. */
    position: integer().notNull(),
  },
  (t) => [
    check('playlist_tracks_position_check', sql`${t.position} >= 0`),
    // Matches Mongo's unique `{ playlistId: 1, order: 1 }`.
    unique('playlist_tracks_playlist_id_position_key').on(t.playlistId, t.position),
    // Matches Mongo's plain (non-unique) `{ playlistId: 1, trackId: 1 }` —
    // the "does this playlist already have track X" existence check in
    // `controllers/playlists.controller.ts`'s add-tracks flow.
    index('playlist_tracks_playlist_id_track_id_idx').on(t.playlistId, t.trackId),
  ]
);

// ── playlist_collaborators (child of playlists — see the file-level doc comment) ──

export const playlistCollaborators = pgTable(
  'playlist_collaborators',
  {
    id: generatedId(),
    playlistId: text()
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    username: text().notNull(),
    role: text({ enum: PLAYLIST_COLLABORATOR_ROLES }).notNull().default('viewer'),
    addedAt: timestamptz().notNull(),
  },
  (t) => [
    check(
      'playlist_collaborators_role_check',
      sql`${t.role} in (${sql.raw(inList(PLAYLIST_COLLABORATOR_ROLES))})`
    ),
    // "Is this user a collaborator of this playlist" — canViewPlaylist /
    // the edit-permission helper.
    unique('playlist_collaborators_playlist_id_oxy_user_id_key').on(t.playlistId, t.oxyUserId),
    // The REVERSE direction — "every playlist this user collaborates on" —
    // getUserPlaylists' `$or: [{ ownerOxyUserId }, { 'collaborators.oxyUserId' }]`.
    // Not served by the unique index above, which leads with playlist_id.
    index('playlist_collaborators_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

// ── playlist_sources (SourceProvenance child table — the fourth sibling; see catalog.ts) ──

export const playlistSources = pgTable(
  'playlist_sources',
  {
    id: generatedId(),
    playlistId: text()
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /**
     * The wide `PROVENANCE_PROVIDERS` set, matching `track_sources` /
     * `album_sources` / `catalog_entity_sources` and the zod
     * `sourceProvenanceSchema` contract — NOT `models/Playlist.ts:28`'s
     * narrower inline `['upload', 'cc']`. That inline enum is wrong today: it
     * disagrees with both the shared zod contract and its three sibling
     * tables. This is declining to port a bug, not widening one.
     */
    provider: text({ enum: PROVENANCE_PROVIDERS }).notNull(),
    externalId: text().notNull(),
    importedAt: timestamptz().notNull(),
    fields: text().array().notNull().default(sql`array[]::text[]`),
  },
  (t) => [
    check('playlist_sources_provider_check', sql`${t.provider} in (${sql.raw(inList(PROVENANCE_PROVIDERS))})`),
    check('playlist_sources_position_check', sql`${t.position} >= 0`),
    unique('playlist_sources_playlist_id_position_key').on(t.playlistId, t.position),
  ]
);

// ── recently_played ───────────────────────────────────────────────────────

export const recentlyPlayed = pgTable(
  'recently_played',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    playedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Primary read pattern: a user's plays, newest first (getRecentlyPlayed's
    // aggregation; the retention-pruning skip/limit in recordRecentlyPlayed).
    index('recently_played_oxy_user_id_played_at_idx').on(t.oxyUserId, t.playedAt.desc()),
  ]
);

// ── playback_states (one row per user — ephemeral "now playing" state) ─────

export const playbackStates = pgTable(
  'playback_states',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per account. */
    oxyUserId: text().notNull(),
    trackId: text().references(() => tracks.id, { onDelete: 'set null' }),
    source: text({ enum: CATALOG_SOURCES }),
    positionMs: integer().notNull().default(0),
    isPlaying: boolean().notNull().default(false),
    // Read whole, never queried by element (services/playback/
    // playbackStateService.ts round-trips it); see the file-level doc comment.
    queue: text().array().notNull().default(sql`array[]::text[]`),
    /** Not id-shaped — a kind discriminator, not a reference itself. */
    contextType: text(),
    /**
     * Polymorphic by `contextType` and entirely client-supplied/unenforced
     * server-side (RELATIONS.md). Left as a plain column — see
     * `deferredForeignKeys.ts`'s ledger entry.
     */
    contextId: text(),
    repeat: text({ enum: PLAYBACK_REPEAT_MODES }).notNull().default('off'),
    shuffle: boolean().notNull().default(false),
    volume: doublePrecision().notNull().default(1),
    /**
     * The real target is the COMPOUND (oxy_user_id, device_id) key on
     * `devices`, not `devices.id` — left unconstrained rather than a
     * composite FK that cannot express the correct ON DELETE behaviour. See
     * the file-level doc comment and `deferredForeignKeys.ts`'s ledger entry.
     */
    activeDeviceId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'playback_states_source_check',
      sql`${t.source} is null or ${t.source} in (${sql.raw(inList(CATALOG_SOURCES))})`
    ),
    check(
      'playback_states_repeat_check',
      sql`${t.repeat} in (${sql.raw(inList(PLAYBACK_REPEAT_MODES))})`
    ),
    check('playback_states_position_ms_check', sql`${t.positionMs} >= 0`),
    check('playback_states_volume_check', sql`${t.volume} between 0 and 1`),
    unique('playback_states_oxy_user_id_key').on(t.oxyUserId),
  ]
);

// ── devices ───────────────────────────────────────────────────────────────

export const devices = pgTable(
  'devices',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /** Client-generated — identifies THIS row, not a reference. See the file-level doc comment. */
    deviceId: text().notNull(),
    name: text().notNull(),
    type: text({ enum: DEVICE_TYPES }).notNull(),
    // Read whole, never queried by element; see the file-level doc comment.
    capabilities: text().array().notNull().default(sql`array[]::text[]`),
    lastSeen: timestamptz().notNull().defaultNow(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('devices_type_check', sql`${t.type} in (${sql.raw(inList(DEVICE_TYPES))})`),
    // One row per (user, device) pair — re-registering updates rather than
    // duplicates. Also the target `playback_states.activeDeviceId` names but
    // cannot reference (see above). Leading column serves plain
    // oxy_user_id-only lookups too, so no separate standalone index is added
    // — an index dropped in writing, per Task 2's own convention.
    unique('devices_oxy_user_id_device_id_key').on(t.oxyUserId, t.deviceId),
  ]
);

// ── user_liked_tracks / user_saved_albums / user_followed_artists /
//    user_saved_playlists / user_podcast_subscriptions (Library's five
//    junctions — see the file-level doc comment) ───────────────────────────

export const userLikedTracks = pgTable(
  'user_liked_tracks',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('user_liked_tracks_oxy_user_id_track_id_key').on(t.oxyUserId, t.trackId)]
);

export const userSavedAlbums = pgTable(
  'user_saved_albums',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    albumId: text()
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('user_saved_albums_oxy_user_id_album_id_key').on(t.oxyUserId, t.albumId)]
);

export const userFollowedArtists = pgTable(
  'user_followed_artists',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('user_followed_artists_oxy_user_id_artist_id_key').on(t.oxyUserId, t.artistId)]
);

export const userSavedPlaylists = pgTable(
  'user_saved_playlists',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    /**
     * The one junction of the five whose CASCADE actually fires in
     * production today — playlists ARE hard-deleted. See the file-level doc
     * comment.
     */
    playlistId: text()
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
  },
  (t) => [unique('user_saved_playlists_oxy_user_id_playlist_id_key').on(t.oxyUserId, t.playlistId)]
);

export const userPodcastSubscriptions = pgTable(
  'user_podcast_subscriptions',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('user_podcast_subscriptions_oxy_user_id_podcast_id_key').on(t.oxyUserId, t.podcastId),
    // The REVERSE direction — "every subscriber of this podcast" —
    // services/notifications/triggers/episodePublished.ts:50's fan-out join.
    // Not served by the unique index above, which leads with oxy_user_id.
    index('user_podcast_subscriptions_podcast_id_idx').on(t.podcastId),
  ]
);
