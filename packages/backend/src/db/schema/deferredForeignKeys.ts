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

/**
 * A table added ahead of its parent goes here with its `ON DELETE` and reason
 * already decided. The moment that parent table appears in the barrel, the
 * gate turns this entry into a hard error naming every column that now owes a
 * real `.references()`.
 *
 * **EMPTY, which is the finish line.** Two entries ever existed and both are
 * closed:
 *
 *  - `userPodcastSubscriptions.podcastId` (Task 3) — closed by Task 4, which
 *    landed `podcasts`; `library.ts`'s column is a real `.references(() =>
 *    podcasts.id, { onDelete: 'cascade' })`.
 *  - `tracks.copyrightReportId` (Task 2) — closed by Task 5, which landed
 *    `copyright_reports` (`schema/creators.ts`); `catalog.ts`'s column is a
 *    real `.references(() => copyrightReports.id, { onDelete: 'set null' })`.
 *
 * Both were DELETED rather than edited, and `__tests__/gates.test.ts` asserts
 * this array equals `[]` — so a later task that needs to defer a key again
 * has to come here and say so deliberately rather than growing the list by
 * accident.
 */
export const DEFERRED_FOREIGN_KEYS: readonly DeferredForeignKey[] = [];

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
  {
    column: 'podcasts.owner_oxy_user_id',
    reason: 'The Oxy account that registered/owns this show (RELATIONS.md: Podcast.ownerOxyUserId).',
  },
  {
    column: 'podcasts.claimed_by_oxy_user_id',
    reason: 'Set when a podcast claim is approved (RELATIONS.md: Podcast.claimedByOxyUserId).',
  },
  {
    column: 'podcast_persons.linked_oxy_user_id',
    reason:
      "Channel-level <podcast:person> credit linked to an Oxy account (RELATIONS.md: " +
      'Podcast.persons[].linkedOxyUserId).',
  },
  {
    column: 'episode_persons.linked_oxy_user_id',
    reason:
      "Per-episode <podcast:person> credit linked to an Oxy account (RELATIONS.md: " +
      'Episode.persons[].linkedOxyUserId).',
  },
  {
    column: 'episode_progress.oxy_user_id',
    reason: 'The Oxy account whose resume position this row tracks (RELATIONS.md: EpisodeProgress.oxyUserId).',
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
  {
    column: 'podcasts.podcast_index_id',
    reason: "PodcastIndex.org's own directory id for this show — not a reference to a Syra row (RELATIONS.md).",
  },
  {
    column: 'podcasts.apple_collection_id',
    reason: "Apple Podcasts' own directory id for this show — not a reference to a Syra row (RELATIONS.md).",
  },
  {
    column: 'podcast_sources.external_id',
    reason: 'Same provenance-log pattern as track_sources.external_id — records which EXTERNAL provider supplied a field.',
  },
  // ── Polymorphic, no single-table FK is expressible ────────────────────────
  {
    column: 'track_keys.track_id',
    reason:
      'Polymorphic across tracks/user_uploads/episodes with no discriminator in the source model ' +
      '(services/ingest/hlsStorage.ts). A `kind` column was added here to at least name which id space ' +
      'applies. All three target tables have now landed (episodes in Task 4, user_uploads in Task 5), ' +
      'so the reason is no longer "the parents do not exist" — it is that Postgres has no conditional ' +
      'foreign key: one column cannot reference a different table per `kind`. Splitting it into three ' +
      'nullable columns with a CHECK would be expressible, and is a real option for whichever task ports ' +
      'hlsStorage.ts, but it is a schema CHANGE rather than a port and is deliberately not made here ' +
      '(RELATIONS.md). ' +
      // ── The live orphan this absence causes, and who owns fixing it ──
      'THE ABSENCE HAS A LIVE CONSEQUENCE, and Task 13 measured it rather than fixing it: with no ' +
      'cascade, every caller that deletes a parent has to delete the key itself, and only ONE of the two ' +
      'does. `controllers/uploads.controller.ts` (`deleteUpload`) deletes it explicitly; ' +
      '`services/uploads/expirySweeper.ts` never has, and that is the path which runs unattended every ' +
      'hour — so most expired uploads leave an AES key behind forever, keyed by an id that resolves to ' +
      'nothing. Both call sites now say so in place. Task 13 ported the vertical at PARITY and did not ' +
      'add a second explicit delete, because that would make the two paths agree while leaving the next ' +
      'caller to remember the same line. OWNER: the `track_keys` split task, dispatched separately — ' +
      'three nullable columns, a CHECK that exactly one is non-null, three ON DELETE cascades, `kind` ' +
      'dropped, and four files outside the creators vertical to update (`services/ingest/hlsStorage.ts` ' +
      'as the writer; `controllers/stream.controller.ts`, `controllers/podcastAudio.controller.ts` and ' +
      '`services/preview/previewService.ts` as readers). It also closes the same latent orphan on the ' +
      '`tracks` and `episodes` arms, which is why it is not scoped to one vertical.',
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
  {
    column: 'user_uploads.owner_oxy_user_id',
    reason: 'The Oxy account whose private locker this file is in (RELATIONS.md: UserUpload.ownerOxyUserId).',
  },
  {
    column: 'artist_claims.oxy_user_id',
    reason:
      'The claimant asking to be recognised as this artist (RELATIONS.md: ArtistClaim.oxyUserId). ' +
      'Half of the partial unique key that allows one OPEN claim per claimant per artist.',
  },
  {
    column: 'contribution_attestations.uploader_oxy_user_id',
    reason:
      'The Oxy account that signed the statement (RELATIONS.md: ContributionAttestation.uploaderOxyUserId). ' +
      "Indexed: compliance's termination cascade reads every recording one account contributed.",
  },
  {
    column: 'contributor_standings.oxy_user_id',
    reason:
      'The Oxy account this infringement record belongs to — one row per account ' +
      '(RELATIONS.md: ContributorStanding.oxyUserId).',
  },
  {
    column: 'copyright_reports.reporter_oxy_user_id',
    reason:
      'The Oxy account that filed the report, optional because the reporting endpoint is public ' +
      '(RELATIONS.md: CopyrightReport.reporterOxyUserId — "public reports may not have user").',
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
  // ── CROSS-SERVICE: Oxy account ids, owned by oxy-api, never a Syra row ────
  {
    column: 'house_members.oxy_user_id',
    reason:
      "A house member's Oxy account id (RELATIONS.md: House.members[].userId). Renamed from Mongo's " +
      '`userId` to match every other Oxy account id in this schema — see the column\'s own comment.',
  },
  {
    column: 'room_user_preferences.oxy_user_id',
    reason:
      'The Oxy account whose live-presence preference this row holds — one row per account ' +
      "(RELATIONS.md: RoomUserPreference.userId). Same rename as house_members.oxy_user_id.",
  },
  // ── EXTERNAL: LiveKit's own ids, not a Syra row ───────────────────────────
  {
    column: 'rooms.active_ingress_id',
    reason:
      "LiveKit's own ingress id for the room's current live stream — an internal stream credential, " +
      'not a reference to a Syra row (RELATIONS.md: Room.activeIngressId).',
  },
  {
    column: 'rooms.recording_egress_id',
    reason:
      "LiveKit's own egress job id, mirroring recordings.egress_id while a recording is in flight " +
      '(RELATIONS.md: Room.recordingEgressId).',
  },
  {
    column: 'recordings.egress_id',
    reason:
      "LiveKit's own egress job id, set from the egress webhook payload — this recording's identity " +
      "at LiveKit, not a reference to a Syra row (RELATIONS.md: Recording.egressId).",
  },
  // ── Polymorphic AND resolved out-of-process over HTTP ─────────────────────
  {
    column: 'room_media_queue_items.episode_id',
    reason:
      "Meaningful only when kind = 'podcast'. Logically an FK to episodes, but the join happens " +
      'through Syra\'s own SDK client over HTTP (routes/rooms.routes.ts:538-565 → syraClient.getEpisode), ' +
      'never in SQL — RELATIONS.md recommends a plain unconstrained column for exactly that ' +
      'indirection. A real key IS expressible now that episodes exists; declining it follows ' +
      'RELATIONS.md rather than the table being unavailable.',
  },
  {
    column: 'room_media_queue_items.track_id',
    reason:
      "Meaningful only when kind = 'track'. Same out-of-process resolution as episode_id, through " +
      'utils/syraMedia.ts:159 rather than a database join (RELATIONS.md: Room.podcastQueue[].trackId).',
  },
  {
    column: 'room_media_queue_items.syra_podcast_id',
    reason:
      "Optional show-level pairing check for a kind = 'podcast' row, cross-checked against the " +
      'resolved episode\'s own show rather than looked up directly — never resolved to a row at all ' +
      '(RELATIONS.md: Room.podcastQueue[].syraPodcastId).',
  },
  // ── CROSS-SERVICE: Oxy account ids, owned by oxy-api, never a Syra row ────
  {
    column: 'user_settings.oxy_user_id',
    reason: 'The Oxy account these profile settings belong to — one row per account (RELATIONS.md).',
  },
  {
    column: 'user_music_preferences.oxy_user_id',
    reason: 'The Oxy account these player preferences belong to — one row per account (RELATIONS.md).',
  },
  {
    column: 'user_behavior.oxy_user_id',
    reason:
      'The Oxy account this personalisation row would belong to — one row per account. Nothing has ' +
      'ever written one; see schema/user.ts\'s file-level doc comment (RELATIONS.md).',
  },
  {
    column: 'user_taste_profiles.oxy_user_id',
    reason: 'The Oxy account whose learned taste this row holds — one row per account (RELATIONS.md).',
  },
  {
    column: 'listening_events.oxy_user_id',
    reason:
      'The Oxy account that played the track (RELATIONS.md: ListeningEvent.oxyUserId). Indexed with ' +
      "played_at: the co-occurrence miner walks one user's events in time order.",
  },
  {
    column: 'notification_preferences.oxy_user_id',
    reason: 'The Oxy account whose event opt-outs this row holds — one row per account (RELATIONS.md).',
  },
  {
    column: 'notification_suppressions.oxy_user_id',
    reason:
      'The Oxy account a notification was already emitted to — half of the unique claim key with ' +
      '`key` (RELATIONS.md: NotificationSuppression.oxyUserId).',
  },
  // ── Polymorphic, no single-table FK is expressible ────────────────────────
  {
    column: 'catalog_relations.source_id',
    reason:
      "Polymorphic by the sibling `kind`: a tracks id when kind = 'track', a catalog_entities id " +
      "when kind = 'artist'. Postgres has no conditional foreign key, and RELATIONS.md recommends " +
      'not enforcing a constraint at all — the co-occurrence job overwrites the whole graph each ' +
      'pass, so this table is a fully disposable cache rather than a record of anything ' +
      '(RELATIONS.md: CatalogRelation.sourceId).',
  },
  {
    column: 'catalog_relations.target_id',
    reason: 'Same polymorphism and same reasoning as catalog_relations.source_id (RELATIONS.md).',
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
