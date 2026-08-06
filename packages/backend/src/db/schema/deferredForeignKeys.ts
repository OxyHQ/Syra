/**
 * Id-Shaped Columns That Carry No Foreign Key
 *
 * Two ledgers, one purpose: between them and the real `.references()`
 * constraints, every id-shaped column in this schema is expected to be
 * classified — which is what lets `__tests__/gates.test.ts` fail on a NEW one
 * nobody decided about, via `@oxyhq/db/assert`'s `findIdColumnViolations`.
 *
 * `DEFERRED_FOREIGN_KEYS` is the TEMPORARY list: a constraint that is decided
 * but not yet expressible because drizzle cannot write a forward reference —
 * a table can land before its parent does. The gate turns each entry into a
 * hard error the moment the parent table appears in the barrel, naming every
 * column that must now reference it. An empty ledger is the finish line.
 *
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` is the PERMANENT counterpart: `*_id`
 * columns that will never carry a constraint, each with its own reason.
 *
 * Both `DeferredForeignKey` and the shape `findIdColumnViolations` expects for
 * `withoutForeignKey` come straight from `@oxyhq/db/assert` rather than being
 * redeclared here — the package now owns both the gate and the types it
 * consumes, so a second local copy could only drift from the one the gate
 * actually checks against.
 */

import type { DeferredForeignKey } from '@oxyhq/db/assert';
import { tracks } from './catalog';
import { userPodcastSubscriptions } from './library';

/**
 * A table added ahead of its parent goes here with its `ON DELETE` and reason
 * already decided. The moment that parent table appears in the barrel, the
 * gate turns this entry into a hard error naming every column that now owes a
 * real `.references()`.
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [
  {
    table: tracks,
    column: tracks.copyrightReportId,
    parentTable: 'copyright_reports',
    parentColumn: 'id',
    onDelete: 'set null',
    reason:
      'copyright_reports is a moderation-vertical table that has not landed yet ' +
      '(RELATIONS.md: Track.copyrightReportId -> copyright_reports, set only at takedown time).',
  },
  {
    table: userPodcastSubscriptions,
    column: userPodcastSubscriptions.podcastId,
    parentTable: 'podcasts',
    parentColumn: 'id',
    onDelete: 'cascade',
    reason:
      'podcasts is a Task 4 table that has not landed yet (RELATIONS.md: ' +
      'Library.subscribedPodcasts[] -> podcasts, CASCADE target-side — ' +
      'services/notifications/triggers/episodePublished.ts:50 reverse-joins this ' +
      'column for new-episode fan-out, which is why it keeps its own index even ' +
      'while the FK itself is deferred).',
  },
];

/**
 * `*_id`-shaped columns that will never carry a constraint, named by their SQL
 * identifier (`table.column`, via `sqlColumnName` — never the TypeScript
 * property name; see that function's own doc comment in `@oxyhq/db` for why).
 *
 * `findIdColumnViolations` itself catches a stale entry (`stale_ledger_entry`)
 * or an incomplete one, so an entry added here ahead of the column it names
 * would fail loudly rather than silently drift.
 */
export const ID_COLUMNS_WITHOUT_FOREIGN_KEY: readonly { column: string; reason: string }[] = [
  // ── CROSS-SERVICE: Oxy account ids, owned by oxy-api, never a Syra row ────
  {
    column: 'catalog_entities.owner_oxy_user_id',
    reason: 'The Oxy account that registered/owns this artist profile (RELATIONS.md).',
  },
  {
    column: 'catalog_entities.claimed_by_oxy_user_id',
    reason: 'Set when an ArtistClaim is approved (RELATIONS.md).',
  },
  {
    column: 'catalog_entities.linked_oxy_user_id',
    reason: 'Strong dedup key for type:person rows — links a podcast credit to an Oxy account (RELATIONS.md).',
  },
  // ── EXTERNAL: another provider's own id, not a Syra row ───────────────────
  {
    column: 'catalog_entities.external_musicbrainz_artist_id',
    reason: 'MusicBrainz artist MBID — the one strong artist identifier an uploaded file can carry (RELATIONS.md).',
  },
  {
    column: 'catalog_entities.external_wikidata_id',
    reason: 'Wikidata QID, filled by enrichment (RELATIONS.md).',
  },
  {
    column: 'catalog_entities.external_discogs_artist_id',
    reason: "Discogs' own artist id, filled by enrichment (RELATIONS.md).",
  },
  {
    column: 'albums.external_musicbrainz_release_id',
    reason: 'MusicBrainz release MBID — dedup tier 2 for album resolution, behind upc (RELATIONS.md).',
  },
  {
    column: 'image_assets.catalog_external_id',
    reason: "A mirrored catalog image's id at its origin provider, e.g. Cover Art Archive (RELATIONS.md).",
  },
  {
    column: 'track_sources.external_id',
    reason: 'The provenance log records which EXTERNAL provider supplied a field, keyed by that provider\'s own id.',
  },
  {
    column: 'album_sources.external_id',
    reason: 'Same provenance-log pattern as track_sources.external_id.',
  },
  {
    column: 'catalog_entity_sources.external_id',
    reason: 'Same provenance-log pattern as track_sources.external_id.',
  },
  {
    column: 'playlist_sources.external_id',
    reason: 'Same provenance-log pattern as track_sources.external_id — the fourth SourceProvenance sibling (RELATIONS.md).',
  },
  {
    column: 'discogs_releases.discogs_release_id',
    reason: "This row's own external identity (Discogs' id for the release) — not a reference to a Syra row (RELATIONS.md).",
  },
  // ── Polymorphic, no single-table FK is expressible ────────────────────────
  {
    column: 'track_keys.track_id',
    reason:
      'Polymorphic across tracks/user_uploads/episodes with no discriminator in the source model ' +
      '(services/ingest/hlsStorage.ts). A `kind` column was added here to at least name which id space ' +
      'applies, but only the track arm has a landed target table today — user_uploads and episodes ' +
      'have not shipped yet, so no conditional per-kind FK can be declared (RELATIONS.md).',
  },
  // ── CROSS-SERVICE: Oxy account ids, owned by oxy-api, never a Syra row ────
  {
    column: 'playlists.owner_oxy_user_id',
    reason: "The playlist owner's Oxy account id (RELATIONS.md: Playlist.ownerOxyUserId).",
  },
  {
    column: 'playlist_collaborators.oxy_user_id',
    reason: "A collaborator's Oxy account id (RELATIONS.md: Playlist.collaborators[].oxyUserId).",
  },
  {
    column: 'recently_played.oxy_user_id',
    reason: 'The Oxy account whose play history this row belongs to (RELATIONS.md: RecentlyPlayed.oxyUserId).',
  },
  {
    column: 'playback_states.oxy_user_id',
    reason: 'The Oxy account this now-playing state belongs to — one row per account (RELATIONS.md: PlaybackState.oxyUserId).',
  },
  {
    column: 'devices.oxy_user_id',
    reason: 'The Oxy account this registered device belongs to (RELATIONS.md: Device.oxyUserId).',
  },
  {
    column: 'user_liked_tracks.oxy_user_id',
    reason: 'The Oxy account that liked the track — the owning side of this junction (RELATIONS.md: Library.oxyUserId).',
  },
  {
    column: 'user_saved_albums.oxy_user_id',
    reason: 'The Oxy account that saved the album — the owning side of this junction (RELATIONS.md: Library.oxyUserId).',
  },
  {
    column: 'user_followed_artists.oxy_user_id',
    reason: 'The Oxy account that followed the artist — the owning side of this junction (RELATIONS.md: Library.oxyUserId).',
  },
  {
    column: 'user_saved_playlists.oxy_user_id',
    reason: 'The Oxy account that saved the playlist — the owning side of this junction (RELATIONS.md: Library.oxyUserId).',
  },
  {
    column: 'user_podcast_subscriptions.oxy_user_id',
    reason: 'The Oxy account that subscribed — the owning side of this junction (RELATIONS.md: Library.oxyUserId).',
  },
  // ── NOT-A-ROW-ID: identifies THIS row (or half of a composite key), not a reference to another ──
  {
    column: 'devices.device_id',
    reason:
      'Client-generated identifier for the physical/app device — identifies THIS row (half of its ' +
      'own composite unique key with oxy_user_id), not a reference to another row (RELATIONS.md: ' +
      'Device.deviceId).',
  },
  // ── Polymorphic / advisory, unenforced by the source app itself ───────────
  {
    column: 'playback_states.context_id',
    reason:
      'Polymorphic by the sibling context_type (playlist/album/artist/…) and, per RELATIONS.md, ' +
      '"entirely client-supplied and never validated server-side against any table" — a stale value ' +
      'has zero functional consequence beyond a UI label (RELATIONS.md: PlaybackState.contextId).',
  },
  {
    column: 'playback_states.active_device_id',
    reason:
      "Not a single-column FK — RELATIONS.md's own note is that the real target is the compound " +
      '(oxy_user_id, device_id) key on devices, not devices.id. A composite `.references()` here would ' +
      'have to ON DELETE SET NULL both referencing columns together (drizzle-orm 0.45.2 has no typed ' +
      'API for the per-column SET NULL(column_list) form Postgres 15 added), which would try to null ' +
      'out oxy_user_id too — a NOT NULL, unique column on this very table. Left as a plain, ' +
      'unconstrained column rather than declaring a composite FK that cannot express the correct ' +
      'ON DELETE behaviour (RELATIONS.md: PlaybackState.activeDeviceId).',
  },
];
