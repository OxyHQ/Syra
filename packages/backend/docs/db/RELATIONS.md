# Syra relation inventory — MongoDB → PostgreSQL

Every identifier-shaped column in `packages/backend/src/models/`, classified by what
it actually points at, recovered by reading the code that joins, looks up, or
filters on it. Mongoose enforces almost none of this — 6 declared `ref:` columns
against ~90 loose `*Id`/`*By`/`*userId`-shaped ones — so the table below, not the
schema files, is the record of what would be lost if a column were dropped or
mis-typed during the port.

## Cross-cutting facts that shape every ON DELETE decision below

1. **Almost nothing in this codebase is ever hard-deleted.** A repo-wide search for
   `TrackModel`/`AlbumModel`/`PodcastModel`/`CatalogEntityModel`/`ArtistModel`/`DeviceModel`
   delete calls (`deleteOne`/`deleteMany`/`findByIdAndDelete`/`findOneAndDelete`)
   across `controllers/`, `services/`, `moderation/`, `routes/` returns **zero
   hits**. Tracks, albums, podcasts, artists/persons and devices are removed from
   view with a boolean (`isAvailable`, `copyrightRemoved`, `terminated`, `status`),
   never a row delete. This is confirmed by `services/compliance/takedown.ts`,
   whose "takedown" path only ever sets `track.isAvailable = false` /
   `track.copyrightRemoved = true` and never touches `PlaylistTrack` or
   `UserLibrary.likedTracks` — those keep pointing at the now-hidden track forever,
   and `playableTrackFilter()`/`isPlayableTrack()` is what hides it at every read
   site. **This means most ON DELETE clauses below are a design decision for a
   case the application has never exercised, not a codified behaviour** — I say so
   per-row.
2. **Rows that ARE hard-deleted today, and what the app does NOT clean up when they are:**
   `Playlist` (`controllers/playlists.controller.ts:383`, WITH cascade —
   `PlaylistTrackModel.deleteMany({ playlistId: id })` runs first at line 380),
   `Room` (`routes/rooms.routes.ts:2515`, **no cascade** — `Recording.roomId`,
   `Series.episodes[].roomId` are left dangling), `House`
   (`routes/houses.routes.ts:354`, **no cascade** — `Room.houseId`,
   `Series.houseId` left dangling), `Series` (`routes/series.routes.ts:328`, **no
   cascade** — `Room.seriesId` left dangling), `UserUpload` (deletion + expiry
   sweeper, WITH cascade of its own `TrackKey` row), `CopyrightReport` (one
   rollback-only `deleteOne`, not a real deletion path — see its row below),
   `ModerationEvent`/`ModerationOutbox`/`ModerationEnforcement` (retention
   sweeps). Where the app silently orphans a reference today, a real `SET NULL`
   constraint is a **strict improvement**, not a behaviour change to defend — I
   recommend it in those rows.
3. **A handful of `*Id` columns are genuinely polymorphic** — which row they name
   depends on a sibling `kind`/`type` field, so no single-table FK can express
   them without either a per-kind check constraint or leaving them unconstrained:
   `CatalogRelation.sourceId`/`targetId` (by `kind: 'track'|'artist'`),
   `Report.reportedId` (by `reportedType`), `ModerationEnforcement.subjectId` (by
   `subjectType`), `Room.podcastQueue[].{episodeId,trackId,syraPodcastId}` (by
   `kind: 'podcast'|'track'`), and `TrackKey.trackId` (by which of three ingest
   pipelines wrote it — **no discriminator column exists at all**, see its row).
4. **CrowdSource** (`@oxyhq/crowdsource`, see `moderation/client.ts`) is a
   third-party moderation SaaS in its own database, exactly like Oxy is for
   `oxyUserId` — its case/decision ids are never a Syra row and never an FK. The
   report's classification list only names `oxyUserId` under CROSS-SERVICE, but
   every CrowdSource id below shares its defining property (never an FK, not a
   catalog-provider id either), so I classify them EXTERNAL with a note rather
   than inventing a fifth bucket.

## Was the 79 figure right?

**No — the true count of loose `*Id: { type: String }` schema columns is 89, not
79.** Verified two ways:

```
$ python3 - <<'EOF'   # single-line-capable, brace-balanced, multi-line-aware scan
... (scans every models/*.ts for `<name>Id: {` blocks containing `type: String`,
    following the brace across up to 10 lines) ...
EOF
89
```

```
$ grep -rnE "^\s*([A-Za-z0-9_]*Id):\s*\{\s*$" *.ts   # opening brace alone on its line
                                                       # = a declaration a single-line
                                                       # regex cannot see at all
House.ts:152 userId · Recording.ts:41 roomId · Recording.ts:63 egressId ·
Room.ts:157 houseId · Room.ts:233 seriesId · Room.ts:255 recordingEgressId ·
Room.ts:261 activeIngressId · RoomUserPreference.ts:31 userId ·
Series.ts:129 roomId · Series.ts:162 houseId
= 10 columns
```

`89 − 10 = 79` exactly. **The 79 figure is what a single-line-only grep finds; it
silently drops every column declared with the opening `{` on its own line** — the
formatting style `Room.ts`, `Series.ts`, `Recording.ts`, `House.ts` and
`RoomUserPreference.ts` use throughout (an older/different hand than the rest of
the codebase, which favours one-line object literals). All 10 of the missed
columns are genuine relations (`Recording.roomId`, `Room.houseId`/`seriesId`,
`Series.roomId`/`houseId`, two `userId` membership columns) — none is noise. The
inventory below is built from the 89, not the 79.

Also corrected: **the declared-`ref:` count is 6, not 7.** Verified with
`grep -rn "Schema.Types.ObjectId, ref:" packages/backend/src/models/*.ts`, which
returns exactly `PlaylistTrack.playlistId`, `Episode.podcastId`, `Room.topicId`,
`EpisodeProgress.episodeId`, `Podcast.linkedArtistId`,
`CatalogEntity(person).linkedArtistId`. I could not find a seventh anywhere in
`packages/backend/src` (checked outside `models/` too, in case one was declared
inline elsewhere — there is none).

## Columns I could not find a reader for (four, all confirmed dead, not just under-read)

| column | evidence it is dead |
|---|---|
| `Room.topicId` (declared `ref: 'Topic'`) | No `Topic` model exists in the repo. `grep -rn "topicId"` outside `models/Room.ts` returns exactly one hit — `routes/rooms.routes.ts:89`, which only lists it in the public-response allowlist. No route ever destructures `topicId` from a request body or sets it on create/update. **Recommend dropping the column** — nothing reads or writes it beyond passthrough. |
| `Track.credits[].catalogEntityId`, `UserUpload.credits[].catalogEntityId`, `DiscogsRelease.credits[].catalogEntityId`, `CatalogEntity.members[].catalogEntityId` (4 declarations, one field) | `grep -rn "catalogEntityId" packages/backend/src --include="*.ts"` outside `models/` returns exactly one **read** (`services/catalog/artistProfile.ts:172`, a filter that is satisfied whenever the field is `undefined`) and **zero writes**, anywhere, including the one script that populates `DiscogsRelease` (`scripts/importDiscogsReleases.ts` never mentions the field). `services/uploads/enrichCatalogEntity.ts:143-146` explicitly documents why the artist-member case is never filled ("linking a member to a catalog entity is a high-confidence identity claim, and a name from Wikidata's `has part` is not one"), but the doc comment on `Track.ts:113` ("`catalogEntityId` is written only on a high-confidence match") describes a write path that does not exist anywhere for any of the four declarations. **This is real** — four separate schema declarations for a "high-confidence credit link" feature with no code that ever sets it. Keep the column (the intent is real and the read site depends on it), but the migration should not expect any non-null values to carry over. |
| `CatalogEntity.imageSuggestions[].sourceUploadId` / `.proposedByOxyUserId` | The only function that ever writes them, `suggestArtistPhotosFromUpload` (`services/uploads/enrichCatalogEntity.ts:447`), has **zero callers** outside its own test file (`grep -rln "suggestArtistPhotosFromUpload"` returns exactly those two files). It is never invoked from `uploads.controller.ts` or any ingest pipeline. The GET/DELETE read paths (`controllers/artists.controller.ts:1093-1097,1225-1239`) are wired and would serve the fields if anything ever populated them — this is a shipped read half of a mechanism whose write half was never connected, the same shape flagged before in this repo (Audius removal left "half-connected mechanisms that typecheck can't see"). |
| `UserBehavior` (whole model — `preferredAuthors`, `preferredTopics`, `preferredPostTypes`, `activeHours`, `preferredLanguages`) | `grep -rln "UserBehavior" packages/backend/src` returns exactly `models/UserBehavior.ts` and `routes/profileSettings.ts`, where the ONLY use is `UserBehavior.findOneAndDelete({ oxyUserId })` (line 213) in account-deletion cleanup. Nothing ever creates or updates a `UserBehavior` document. The shape itself (`poll`/`video`/`text` post-type counters, "preferred authors") reads like a leftover from a generic social-feed scaffold, not anything Syra (a music/podcast/rooms product) has a feature for. **Recommend dropping the whole table** rather than porting it — there is no data-loss risk because nothing has ever been written into it.

## Relation table

Columns: **source** (`Model.field`) · **classification** (FK / CROSS-SERVICE /
EXTERNAL / NOT-A-ROW-ID) · **target** (FK only) · **ON DELETE** · **proof**
(`file:line`) · **note**.

### Album

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Album.artistId` | FK | `catalog_entities` (artist) | RESTRICT | `controllers/albums.controller.ts:261,308` (`findOwnedArtist(album.artistId, userId)`); `utils/playableContainers.ts:41-49,156` (`$lookup` join for playable-album filtering) | Required, indexed. No code ever deletes an artist row (fact 1) — RESTRICT documents that assumption rather than changing behaviour. |
| `Album.externalIds.musicbrainzReleaseId` | EXTERNAL | — | — | `models/Album.ts:126` (sparse-unique dedup index); `services/uploads/resolveAlbum.ts:158,329` | MusicBrainz release MBID — dedup tier 2, behind `upc`. |
| `Album.externalIds.isrc` | EXTERNAL | — | — | `models/Album.ts:117` (sparse index) | Present on the album model for symmetry with Track; not the primary ISRC field (that's `Track.externalIds.isrc`). |
| `Album.sources[].externalId` | EXTERNAL | — | — | `services/uploads/resolveAlbum.ts:294-299` (`sources: [{ provider: 'cover-art-archive', externalId: input.musicbrainzReleaseId ?? … }]`) | Provenance log: which external provider supplied which field, keyed by that provider's own id. |

### ArtistClaim

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ArtistClaim.artistId` | FK | `catalog_entities` (artist) | CASCADE | `controllers/artists.controller.ts:517,729,765` (`ArtistModel.findOne/findById` by claim.artistId; duplicate-pending-claim check scoped to it) | A claim has no meaning without the artist it claims. |
| `ArtistClaim.oxyUserId` | CROSS-SERVICE | — | — | `models/ArtistClaim.ts:32` (unique-with-artistId-while-pending index); `controllers/artists.controller.ts` claim creation | The claimant's Oxy account id. |
| `ArtistClaim.resolvedBy` | CROSS-SERVICE | — | — | `controllers/artists.controller.ts:753` (`claim.resolvedBy = reviewerId`) | Not `*Id`-suffixed — found only by reading the controller, not by the naming-pattern grep. The admin/reviewer's Oxy account id. |

### CatalogEntity (`artist` + `person` discriminators, collection `catalogentities`)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `CatalogEntity(person).linkedArtistId` | FK (declared `ref`) | `catalog_entities` (self, artist) | SET NULL | `models/CatalogEntity.ts:464,468` (sparse index); doc comment "Links this person to a `type:'artist'` entity (claimed/owned artist)" | Absent already means "not yet linked" — the natural default state, so SET NULL promotes an orphan into the same state a never-linked person already has. |
| `CatalogEntity.ownerOxyUserId` | CROSS-SERVICE | — | — | `models/CatalogEntity.ts:287` (index); `controllers/artists.controller.ts:1133,1220` (`ArtistModel.findOne({ ownerOxyUserId: userId })`) | The Oxy account that registered/owns this artist profile. |
| `CatalogEntity.claimedByOxyUserId` | CROSS-SERVICE | — | — | `services/uploads/enrichCatalogEntity.ts:454` (`.select('_id claimedByOxyUserId')`) | Set when an `ArtistClaim` is approved. |
| `CatalogEntity.linkedOxyUserId` | CROSS-SERVICE | — | — | `scripts/reseedPersons.ts:5,9,78`; `services/podcasts/resolvePersons.ts:61-65,87,143-164` (strong dedup key, `PersonModel.deleteMany({ linkedOxyUserId: null })`) | Strong dedup key for `type:'person'` rows — links a podcast host/guest credit to a real Oxy account. |
| `CatalogEntity.strikes[].trackId` | FK | `tracks` | SET NULL | `services/strikeService.ts:76` (`{ reason, createdAt: new Date(), trackId }` pushed into `artist.strikes`); called from `services/compliance/takedown.ts:614` | Optional per-strike audit pointer to the offending track. Losing the track must not lose the strike (moderation history) — SET NULL, not CASCADE. Tracks are never hard-deleted in practice (fact 1), so this is untested territory either way. |
| `CatalogEntity.externalIds.musicbrainzArtistId` | EXTERNAL | — | — | `models/CatalogEntity.ts:428-431` (unique sparse index); `services/uploads/resolveArtist.ts:135` | MusicBrainz artist MBID — the one strong artist identifier an uploaded file can carry. |
| `CatalogEntity.externalIds.wikidataId` | EXTERNAL | — | — | `services/uploads/enrichCatalogEntity.ts:173` (`fillText('externalIds.wikidataId', …)`) | |
| `CatalogEntity.externalIds.discogsArtistId` | EXTERNAL | — | — | `models/CatalogEntity.ts:172` (declared alongside the others; enrichment source) | Not read outside enrichment fill helpers in the code I found — same enrichment path as `musicbrainzArtistId`/`wikidataId`. |
| `CatalogEntity.externalIds.isni` / `.ipi` | EXTERNAL | — | — | `services/uploads/enrichCatalogEntity.ts:177-178` (`fillText('externalIds.isni', …)`, `fillText('externalIds.ipi', …)`) | International Standard Name Identifier / Interested Parties Information code. |
| `CatalogEntity.externalIds.isrc` | EXTERNAL | — | — | `models/CatalogEntity.ts:165` | Present for symmetry; not the artist's own identity key. |
| `CatalogEntity.members[].catalogEntityId` | FK (dead) | `catalog_entities` (self, artist) | SET NULL | See "dead readers" table above | Never written anywhere. Deliberately so, per `services/uploads/enrichCatalogEntity.ts:143-146`. |
| `CatalogEntity.sources[].externalId` | EXTERNAL | — | — | Same provenance-log pattern as `Album.sources[].externalId` | |
| `CatalogEntity.imageSuggestions[].proposedByOxyUserId` | CROSS-SERVICE (dead write path) | — | — | See "dead readers" table above; read at `controllers/artists.controller.ts:1096,1238` | Reachable only via a function with no production callers. |
| `CatalogEntity.imageSuggestions[].sourceUploadId` | FK (dead write path) | `user_uploads` | SET NULL | See "dead readers" table above | Same dead-write caveat. Target is `UserUpload` per the doc comment "extracted from a stranger's file" and `ArtistPhotoSuggestionInput`'s only caller shape. |
| `CatalogEntity(artist).strikes[]._id` / general | — | — | — | — | (Sub-document `_id`s are not relations; omitted.) |

### CatalogRelation (precomputed recommendation graph — fully regenerable)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `CatalogRelation.sourceId` | FK (polymorphic, by `kind`) | `tracks` or `catalog_entities` | no action | `services/recommendations/recommendationService.ts:90,149` (`CatalogRelationModel.find({ kind: 'artist'\|'track', sourceId })`); `services/recommendations/coOccurrenceJob.ts:172-196` (job that (re)writes the whole graph) | `kind` discriminates the target table; no single-table FK can express this without a check-constraint-per-kind. The job "overwrites the graph each pass" (model doc comment) — this collection is a fully disposable cache. **Recommend not enforcing a constraint at all** and considering whether to migrate any rows vs. just re-running the job after cutover. |
| `CatalogRelation.targetId` | FK (polymorphic, by `kind`) | `tracks` or `catalog_entities` | no action | Same as above | Same reasoning. |

### ContributionAttestation

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ContributionAttestation.trackId` | FK | `tracks` | RESTRICT | `models/ContributionAttestation.ts:55` (unique — one row per contributed track); model doc comment: "the statement they signed is the only thing standing between Syra and the claim that it distributed the work on its own initiative" | This is a legal evidence record — the doc's own reasoning ("evidence... has to outlive" the object, applied to `rawTags`) argues against ever letting a track deletion silently take the evidence with it. RESTRICT forces an explicit decision if a track row is ever hard-deleted. |
| `ContributionAttestation.uploaderOxyUserId` | CROSS-SERVICE | — | — | `models/ContributionAttestation.ts:56` (required, indexed) | |

### ContributorStanding

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ContributorStanding.oxyUserId` | CROSS-SERVICE | — | — | `models/ContributorStanding.ts:59` (unique — one row per Oxy account) | The infringement record of an ordinary (non-artist) Oxy account — see the model's extensive doc comment on why this is a separate collection from `CatalogEntity.strikes`. |
| `ContributorStanding.strikes[].trackId` | FK | `tracks` | SET NULL | `services/compliance/contributorStrikes.ts:52` (`standing.strikes.push({ reason, createdAt: new Date(), trackId })`) | Same reasoning as `CatalogEntity.strikes[].trackId` — audit record, must survive the track. |

### CopyrightReport

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `CopyrightReport.trackId` | FK | `tracks` | RESTRICT | `models/CopyrightReport.ts:16,34` (compound index); `controllers/artists.controller.ts:971-980` (created at takedown time) | DMCA evidence — same "must survive" reasoning as `ContributionAttestation`. |
| `CopyrightReport.artistId` | FK | `catalog_entities` (artist) | RESTRICT | `models/CopyrightReport.ts:17,35`; `controllers/copyright.controller.ts:61,106` | |
| `CopyrightReport.reporterOxyUserId` | CROSS-SERVICE | — | — | `models/CopyrightReport.ts:18` (optional — "public reports may not have user") | |
| `CopyrightReport.resolvedBy` | CROSS-SERVICE | — | — | `controllers/copyright.controller.ts:217` (`report.resolvedBy = reviewerId`) | Not `*Id`-suffixed. The one `CopyrightReportModel.deleteOne` in the codebase (`controllers/artists.controller.ts:993`) is rollback-only, for a report describing a takedown that never happened — not a real deletion path, so this row is effectively append-only in practice. |

### Device

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Device.oxyUserId` | CROSS-SERVICE | — | — | `models/Device.ts:21,33` (compound unique with `deviceId`) | |
| `Device.deviceId` | NOT-A-ROW-ID | — | — | `services/playback/deviceService.ts:21` (`{ oxyUserId: userId, deviceId: input.deviceId }` upsert key) | Client-generated identifier for the physical/app device — identifies *this* row (half of its own composite key with `oxyUserId`), not a reference to another row. |

### DiscogsRelease (read-only importer mirror)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `DiscogsRelease.discogsReleaseId` | EXTERNAL | — | — | `models/DiscogsRelease.ts:53` (unique) | This row's own external identity (Discogs' id for the release), the same pattern as `MusicBrainzArtist.mbid`/`IsrcRegistry.isrc` — not a reference to a Syra row. |
| `DiscogsRelease.credits[].catalogEntityId` | FK (dead) | `catalog_entities` | SET NULL | See "dead readers" table above | Never written, including by the one script (`scripts/importDiscogsReleases.ts`) that populates this collection. |

### Episode

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Episode.podcastId` | FK (declared `ref`) | `podcasts` | CASCADE | `models/Episode.ts:92,134,136` (required, compound unique with `guid`) | An episode with no show is meaningless. Podcasts are never hard-deleted today (fact 1), so this is untested but the semantically correct choice. |
| `Episode.persons[].linkedOxyUserId` | CROSS-SERVICE | — | — | `services/podcasts/resolvePersons.ts:61-65,143-164` | Per-episode `<podcast:person>` credit linked to an Oxy account. |

### EpisodeProgress

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `EpisodeProgress.oxyUserId` | CROSS-SERVICE | — | — | `models/EpisodeProgress.ts:21,31` (compound unique with `episodeId`) | |
| `EpisodeProgress.episodeId` | FK (declared `ref`) | `episodes` | CASCADE | `models/EpisodeProgress.ts:22,31` | Per-user resume position — meaningless once the episode is gone. |

### House

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `House.createdBy` | CROSS-SERVICE | — | — | `models/House.ts:196-200` (indexed) | Not `*Id`-suffixed. |
| `House.members[].userId` | CROSS-SERVICE | — | — | `routes/houses.routes.ts:191,463,535,554` (`house.members.find/filter` by `userId`) | Multi-line schema declaration — one of the 10 columns a single-line grep misses. |

### ImageAsset

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ImageAsset.uploadedBy` | CROSS-SERVICE | — | — | `controllers/images.controller.ts:54`; `controllers/uploads.controller.ts:609` | Optional. Not `*Id`-suffixed. |
| `ImageAsset.catalog.externalId` | EXTERNAL | — | — | `models/ImageAsset.ts:41,63` (compound index with provider/entityType/size) | A mirrored catalog image's id at its origin provider (e.g. Cover Art Archive). |

### IsrcRegistry / MusicBrainzArtist (read-only importer mirrors)

No relation columns — `isrc`/`recordingMbid` (IsrcRegistry) and `mbid` (MusicBrainzArtist)
are each collection's own natural key from the external dataset it mirrors, not a
reference to anything. Included here only to record that they were checked and
have nothing to report.

### Library (`useruploads`… no — collection `userlibraries`, model `UserLibrary`)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Library.oxyUserId` | CROSS-SERVICE | — | — | `models/Library.ts:19` (unique — one row per account) | The owning side of all five junction relations below. |
| `Library.likedTracks[]` | FK array → `tracks` | CASCADE (target-side) | `controllers/library.controller.ts:127,165-186` (`addToLibrary`/`removeFromLibrary`) | Becomes a `user_liked_tracks (oxy_user_id, track_id)` junction table. If the target track row is ever hard-deleted, the like should disappear with it. |
| `Library.savedAlbums[]` | FK array → `albums` | CASCADE (target-side) | `controllers/library.controller.ts:105,206-227` | → `user_saved_albums`. |
| `Library.followedArtists[]` | FK array → `catalog_entities` (artist) | CASCADE (target-side) | `controllers/library.controller.ts:106,246-268` | → `user_followed_artists`. |
| `Library.savedPlaylists[]` | FK array → `playlists` | CASCADE (target-side) | `controllers/library.controller.ts:107,287-308` | → `user_saved_playlists`. Playlists ARE hard-deleted (fact 2) — this is the one array relation whose CASCADE will actually fire in production; verify the playlist-delete handler also cleans this junction (it currently does **not** — `controllers/playlists.controller.ts:380` only clears `PlaylistTrack`, not every `Library.savedPlaylists` array that references it — a real orphan today that a DB-level CASCADE would fix). |
| `Library.subscribedPodcasts[]` | FK array → `podcasts` | CASCADE (target-side) | `controllers/podcasts.controller.ts:354-402`; `services/notifications/triggers/episodePublished.ts:50` (`UserLibraryModel.find({ subscribedPodcasts: episode.podcastId })` — reverse join for notification fan-out) | → `user_subscribed_podcasts`. |

### ListeningEvent (TTL-bounded, 90-day retention — see fact box)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ListeningEvent.oxyUserId` | CROSS-SERVICE | — | — | `models/ListeningEvent.ts:76,91` | |
| `ListeningEvent.trackId` | FK | `tracks` | CASCADE | `models/ListeningEvent.ts:77`; `services/recommendations/coOccurrenceJob.ts:78,112` | Short-lived event log (self-expires in 90 days per its own TTL index) feeding precomputed aggregates — the durable artifacts are `UserTasteProfile`/`CatalogRelation`, not these rows, so losing events alongside a deleted track is harmless. |
| `ListeningEvent.artistId` | FK | `catalog_entities` (artist) | CASCADE | `models/ListeningEvent.ts:78`; `services/recommendations/coOccurrenceJob.ts:78,112,136` | Same reasoning. |

### Lyrics

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Lyrics.trackId` | FK | `tracks` | CASCADE | `models/Lyrics.ts:25` (unique) | 1:1 dependent child — lyrics have no meaning without their track. |

### ModerationEnforcement / ModerationEvent / ModerationOutbox

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `ModerationEnforcement.decisionId` | EXTERNAL | — | — | `models/ModerationEnforcement.ts:96,132-136` (idempotency key `decisionId + revision + action`) | CrowdSource's own decision id (see fact 4). |
| `ModerationEnforcement.caseId` | EXTERNAL | — | — | `models/ModerationEnforcement.ts:103` (indexed) | CrowdSource's own case id. |
| `ModerationEnforcement.subjectId` | FK (polymorphic, by `subjectType`) | `tracks`, `playlists`, `houses`, or `rooms` | RESTRICT/no action | `moderation/enforcement-service.ts:109-178,195-257` (`switch (subject.type)` dispatching to `TrackModel`/`PlaylistModel`/`HouseModel`/`RoomModel` by `_id: subject.id`) | Narrower target set than `Report.reportedId` — matches Syra's list of "reversible restrictions" (no artist/podcast/episode/user case in this switch). |
| `ModerationEvent.caseId` | EXTERNAL | — | — | `models/ModerationEvent.ts:52` (indexed); dedup/audit collection for CrowdSource webhook deliveries | CrowdSource's own case id. |
| `ModerationOutbox.leaseOwner` | NOT-A-ROW-ID | — | — | `moderation/outbox.ts:183-232` (claim/renew/release-lease calls) | An ephemeral worker/process lock tag, not a reference to any row. |
| `ModerationOutbox.payload.{reportId,eventId,caseId}` | (not a schema column) | — | — | `models/ModerationOutbox.ts:35-52` | These live inside `Schema.Types.Mixed` — real relations (`reportId` → `Report._id`) but stored as opaque JSON, not an indexable/typed column. Flagging for awareness; not given a full row since there is nothing to type-migrate — the payload should stay JSONB. |

### PlaybackState (one row per user — ephemeral "now playing" state)

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `PlaybackState.oxyUserId` | CROSS-SERVICE | — | — | `models/PlaybackState.ts:26` (unique) | |
| `PlaybackState.trackId` | FK | `tracks` | SET NULL | `services/playback/playbackStateService.ts` (round-tripped); `services/recommendations/recordPlay.ts` | Optional. Losing the track should just clear "now playing", not error. |
| `PlaybackState.contextId` | FK (polymorphic, by `contextType`; unenforced) | `playlists`/`albums`/`catalog_entities`/… | SET NULL | `services/playback/playbackStateService.ts:26,33,52,70-71` | **Entirely client-supplied and never validated server-side against any table** — `grep -rn "contextType\|contextId"` outside the model and this one service returns nothing. Treat as an opaque advisory string; a stale value has zero functional consequence beyond a UI label. |
| `PlaybackState.activeDeviceId` | FK | `devices` (compound key `oxyUserId + deviceId`) | SET NULL | `services/playback/deviceService.ts:45-57` (`markInactive`/`heartbeat` keyed on `{ oxyUserId, deviceId }`); `services/playback/playbackStateService.ts:185-199` (explicitly clears/reassigns on device disconnect) | Not a simple single-column FK — the target is the `(oxy_user_id, device_id)` compound unique key on `devices`, not `devices.id`. |
| `PlaybackState.queue[]` | FK array → `tracks` (unenforced) | — | — | `services/playback/playbackStateService.ts:24,69,127,145` (round-tripped, never joined against `Track` server-side) | Same "opaque, client-controlled" caveat as `contextId`. Recommend a plain array/JSONB column with no constraint rather than a real FK array. |

### PlaylistTrack

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `PlaylistTrack.playlistId` | FK (declared `ref`) | `playlists` | CASCADE | `controllers/playlists.controller.ts:380,383,514` (app already does `PlaylistTrackModel.deleteMany({ playlistId: id })` before `PlaylistModel.findByIdAndDelete` — this is a **codified** behaviour, not a hypothetical) | Matches existing application-level cascade exactly. |
| `PlaylistTrack.trackId` | FK | `tracks` | CASCADE | `utils/playableContainers.ts:90-104` (`$lookup` join, string→ObjectId `$convert` on the local side) | No code ever hard-deletes a track (fact 1), so this is a design choice for an untested case; CASCADE avoids dangling playlist rows a hard delete would otherwise leave (the same shape as the `Room`/`House`/`Series` orphans in fact 2). |

### Playlist

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Playlist.ownerOxyUserId` | CROSS-SERVICE | — | — | `utils/catalogVisibility.ts:85,101` (`canViewPlaylist`); `models/Playlist.ts:71` (index) | |
| `Playlist.collaborators[].oxyUserId` | CROSS-SERVICE | — | — | `utils/catalogVisibility.ts:86,102` (`collaborators?.some(entry => entry.oxyUserId === userId)`) | |
| `Playlist.externalIds.isrc` | EXTERNAL | — | — | `models/Playlist.ts:24` | |
| `Playlist.sources[].externalId` | EXTERNAL | — | — | Same provenance-log pattern as `Album`/`CatalogEntity`/`Track` | |

### Podcast

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Podcast.linkedArtistId` | FK (declared `ref`) | `catalog_entities` (artist) | SET NULL | `models/Podcast.ts:100,138` (sparse index) | Absent = "not yet linked to an artist profile", already the default state — SET NULL matches it exactly, same reasoning as `CatalogEntity(person).linkedArtistId`. |
| `Podcast.ownerOxyUserId` | CROSS-SERVICE | — | — | `models/Podcast.ts:97,136` (sparse index) | |
| `Podcast.claimedByOxyUserId` | CROSS-SERVICE | — | — | `models/Podcast.ts:99,137` (sparse index) | |
| `Podcast.persons[].linkedOxyUserId` | CROSS-SERVICE | — | — | `services/podcasts/resolvePersons.ts:61-65,208,244-265` | Channel-level `<podcast:person>` credit. |
| `Podcast.sources[].externalId` | EXTERNAL | — | — | `models/Podcast.ts:61-70` (`PodcastSourceProvenanceSchema`) | |
| `Podcast.podcastGuid` | EXTERNAL | — | — | `models/Podcast.ts:91,128` (unique sparse) | RSS `<podcast:guid>`. |
| `Podcast.feedUrl` | EXTERNAL | — | — | `models/Podcast.ts:90,127` (unique sparse) | Not `*Id`-shaped at all but is this table's external join key — included for completeness. |
| `Podcast.podcastIndexId` | EXTERNAL | — | — | `models/Podcast.ts:92,129` (sparse index) | **`Number`-typed, not `String`** — outside the 89-column String scan entirely; found only by reading the file. PodcastIndex.org's directory id. |
| `Podcast.appleCollectionId` | EXTERNAL | — | — | `models/Podcast.ts:93,130` (sparse index) | Also `Number`-typed. Apple Podcasts directory id. |

### RecentlyPlayed

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `RecentlyPlayed.oxyUserId` | CROSS-SERVICE | — | — | `models/RecentlyPlayed.ts:20,28` | |
| `RecentlyPlayed.trackId` | FK | `tracks` | CASCADE | `models/RecentlyPlayed.ts:21` | Per-play history row, capped per user — same disposability reasoning as `ListeningEvent`. |

### Recording

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Recording.roomId` | FK | `rooms` | SET NULL, **and relax to nullable** | `routes/rooms.routes.ts:826-837` (`new Recording({ roomId: String(room._id), … })`) | Currently `required: true`, but `Room` rows ARE hard-deleted (fact 2) with **no check for existing recordings and no cleanup** — a room with recordings can be deleted today, silently orphaning this column. Recordings are meant to outlive room lifecycle (they carry their own `expiresAt`/`access` and are served as a standalone resource via `routes/recordings.routes.ts`), so CASCADE (deleting valuable recorded audio because someone deleted the room) is wrong; RESTRICT would change today's (accidentally permissive) behaviour. Recommend making the column nullable and SET NULL — a genuine schema improvement flagged for the schema task, not a silent behaviour change. |
| `Recording.host` | CROSS-SERVICE | — | — | `routes/recordings.routes.ts:70-154` (`isHost = userId === recording.host`) | Denormalized copy of `Room.host` at recording-start time. |
| `Recording.participantIds[]` | CROSS-SERVICE array | — | — | `routes/rooms.routes.ts:872` (`recording.participantIds = room.participants \|\| []`); `routes/recordings.routes.ts:26,72` | Snapshot of `Room.participants` at recording-stop time, not a live join. |
| `Recording.egressId` | EXTERNAL | — | — | `models/Recording.ts:63` (unique); set from LiveKit's egress-webhook payload | LiveKit's own egress job id. |

### Report

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Report.reportedId` | FK (polymorphic, by `reportedType`) | `playlists`, `houses`, `catalog_entities` (artist), `tracks`, or `rooms` | RESTRICT/no action | `moderation/subjects/providers.ts:61,122,178,249,353` (`PlaylistModel.findById`/`HouseModel.findById`/`ArtistModel.findById`/`TrackModel.findById`/`RoomModel.findById`, each keyed to its `ReportedType`) | `podcast`/`episode`/`user` are accepted `ReportedType` values but have **no** provider in `SYRA_SUBJECT_PROVIDERS` — see the model's own doc comment: "Accepted, never delivered." So for those three types `reportedId` never resolves against any table at all; it is stored and never joined. |
| `Report.reporter` | CROSS-SERVICE | — | — | `models/Report.ts:120,164,214` (compound unique with `reportedType`+`reportedId`) | Not `*Id`-suffixed; the reporter's Oxy user id ("which IS the §11.14 binding proof" per doc comment). |
| `Report.crowdSourceReportId` | EXTERNAL | — | — | `models/Report.ts:130,190` | CrowdSource's own id for this report. |
| `Report.crowdSourceCaseId` | EXTERNAL | — | — | `models/Report.ts:131,191` (indexed) | CrowdSource's own case id — the same case multiple `Report` rows can merge into. |
| `Report.decisionId` | EXTERNAL | — | — | `models/Report.ts:137,196` | CrowdSource's own decision id. |

### Room

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Room.topicId` (declared `ref: 'Topic'`) | FK (dead — no such table, recommend dropping the column) | — (would-be `topics`, table does not exist) | — | See "dead readers" table above | No `Topic` model exists; nothing writes it. |
| `Room.host` | CROSS-SERVICE | — | — | `routes/rooms.routes.ts:52,155,327` (indexed, ownership checks throughout) | |
| `Room.houseId` | FK | `houses` | SET NULL | `routes/rooms.routes.ts:156,941,1069,1323,1608` (`House.findById(room.houseId)`, query filters, ownership checks) | Already nullable — a profile-owned room has `houseId: undefined` (fact confirmed at `HouseSchema` doc + `routes/rooms.routes.ts:987`). House deletion today leaves this dangling with **no cleanup** (fact 2) — SET NULL converts that into the same, already-meaningful, "profile-owned room" state. |
| `Room.createdByAdmin` | CROSS-SERVICE | — | — | `models/Room.ts:69,162-165` ("audit trail for AGORA-owned rooms") | |
| `Room.participants[]` | CROSS-SERVICE array | — | — | `routes/rooms.routes.ts:872,989` | |
| `Room.speakers[]` | CROSS-SERVICE array | — | — | `routes/rooms.routes.ts:961,989,1186-1189` (`broadcasters = host ∪ speakers`) | |
| `Room.seriesId` | FK | `series` | SET NULL | `routes/series.routes.ts:407,415` (set when a room is generated from a series template) | Same "already-meaningful absence" reasoning as `houseId` — most rooms have no `seriesId` at all. Series deletion today leaves this dangling with no cleanup (fact 2). |
| `Room.recordingEgressId` | EXTERNAL | — | — | `routes/rooms.routes.ts:790` (cleared on auto-stop) | LiveKit egress id — mirrors `Recording.egressId` while a recording is in flight. |
| `Room.activeIngressId` | EXTERNAL | — | — | `models/Room.ts:105,261` (excluded from `PUBLIC_ROOM_FIELDS` — internal stream credential) | LiveKit ingress id for the current live stream. |
| `Room.podcastQueue[].episodeId` | FK (polymorphic, `kind:'podcast'`) | `episodes` (via Syra's own public API, not a direct DB join) | — | `routes/rooms.routes.ts:538-565,627` (`resolvePodcastEpisode(episodeId, expectedPodcastId)` → `syraClient.getEpisode(episodeId)`) | Resolved out-of-process through Syra's own SDK client rather than `EpisodeModel.findById` — still logically an FK to `episodes`, but the join happens over HTTP, not SQL. Worth a plain unconstrained column, not a hard FK, given that indirection. |
| `Room.podcastQueue[].syraPodcastId` | FK (polymorphic, `kind:'podcast'`, optional) | `podcasts` | — | `routes/rooms.routes.ts:545` (`expectedPodcastId`, cross-checked against the resolved episode's own show, not looked up directly); `utils/syraPodcast.ts:114-120` (`sanitizePodcast`) | Optional pairing check, not itself resolved to a row. |
| `Room.podcastQueue[].trackId` | FK (polymorphic, `kind:'track'`) | `tracks` (via `utils/syraMedia.ts` resolver, same out-of-process pattern) | — | `routes/rooms.routes.ts:578-605` (`resolveTrack(trackId)`); `utils/syraMedia.ts:159` | Same out-of-process-resolution caveat as `episodeId`. |

### RoomUserPreference

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `RoomUserPreference.userId` | CROSS-SERVICE | — | — | `models/RoomUserPreference.ts:31-36` (unique — one row per account) | Multi-line declaration — one of the 10 a single-line grep misses. |

### Series

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Series.houseId` | FK | `houses` | SET NULL | `routes/series.routes.ts:398` (`series.houseId ? OwnerType.HOUSE : OwnerType.PROFILE`); `models/Series.ts:162,205` | Optional — "can belong to a house." Multi-line declaration (one of the 10). |
| `Series.createdBy` | CROSS-SERVICE | — | — | `routes/series.routes.ts:106,208,315,367,468` (permission checks throughout) | Not `*Id`-suffixed. |
| `Series.episodes[].roomId` | FK | `rooms` | — (historical log; see note) | `routes/series.routes.ts:425-429` (`series.episodes.push({ roomId: room._id.toString(), … })`, written in the same request as `Room.seriesId`) | The reverse half of `Room.seriesId` — both written together when a room is generated from a series. This is an append-only history array (one entry per generated episode), so a target row disappearing shouldn't need to rewrite history; recommend leaving it unconstrained (or `SET NULL` if it becomes its own child table) rather than CASCADE, so deleting one generated room doesn't erase the series' record that an episode N was ever scheduled. |

### Track

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `Track.artistId` | FK | `catalog_entities` (artist) | RESTRICT | `controllers/tracks.controller.ts:442-460`; `utils/playableContainers.ts:41-52,192`; dozens of read sites across `services/recommendations/*`, `services/radio/*`, `services/uploads/*` | The single densest relation in the codebase (~90+ call sites read/write it). Artists are never hard-deleted (fact 1) — RESTRICT. |
| `Track.albumId` | FK | `albums` | SET NULL | `controllers/tracks.controller.ts:459-460` (`AlbumModel.findById(updates.albumId).select('artistId')`, cross-checked against `track.artistId`); `utils/playableContainers.ts:41-52,156` | Optional (`index: true`, no `required`) — a track can exist with no album. |
| `Track.credits[].catalogEntityId` | FK (dead) | `catalog_entities` | SET NULL | See "dead readers" table above; read (never written) at `services/catalog/artistProfile.ts:172` | |
| `Track.copyrightReportId` | FK | `copyright_reports` | SET NULL | `services/compliance/takedown.ts:567` (`track.copyrightReportId = copyrightReportId`); set from `controllers/copyright.controller.ts:204` and `controllers/artists.controller.ts:986` | Optional, set only on takedown. |
| `Track.removedBy` | CROSS-SERVICE | — | — | `services/compliance/takedown.ts:566` (`track.removedBy = actorOxyUserId`) | Not `*Id`-suffixed. The Oxy account that performed the removal. |
| `Track.externalIds.isrc` | EXTERNAL | — | — | `models/Track.ts:205` (unique sparse — dedup tier); `services/uploads/matchCatalog.ts:180`; `services/uploads/resolveArtist.ts:211` | The primary ISRC field (see the model's own comment distinguishing it from `metadata`). |
| `Track.sources[].externalId` | EXTERNAL | — | — | Same provenance-log pattern as `Album`/`CatalogEntity`/`Playlist` | |

### TrackFingerprint / TrackKey

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `TrackFingerprint.trackId` | FK | `tracks` | CASCADE | `models/TrackFingerprint.ts:32,75` (unique — `indexTrackAcoustically` upserts by it) | Acoustic index, meaningless without the track it fingerprints. |
| `TrackKey.trackId` | FK (polymorphic — **no discriminator column at all**) | `tracks`, `user_uploads`, **or** `episodes` | — | `services/ingest/hlsStorage.ts:108-115` (code comment: "`TrackKey.trackId` holds a Track id for catalog jobs and a UserUpload id for locker jobs"); `controllers/uploads.controller.ts:2288,2623` (`{ trackId: upload._id.toString() }`, `{ trackId: uploadId }`); `controllers/podcastAudio.controller.ts:272` (`{ trackId: episodeId }`) | The single most structurally awkward relation in the inventory: this collection is a shared AES-key store keyed by "whatever content id owns this HLS asset," across **three** different tables, distinguished only by which id space the caller happens to be in (three separate ObjectId spaces never collide, per the code comment) — there is no `kind`/`sourceModel` field to discriminate them. **Cannot be a real single-target FK without adding a discriminator column first** (a schema change, out of scope for this inventory) — recommend leaving it as a plain indexed string column with no constraint, or adding the discriminator as part of the schema task. |

### UserBehavior — see "dead readers" above; whole model recommended for drop, not migration.

### UserMusicPreferences / UserSettings / UserTasteProfile

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `UserMusicPreferences.oxyUserId` | CROSS-SERVICE | — | — | `models/UserMusicPreferences.ts:35` (unique) | |
| `UserSettings.oxyUserId` | CROSS-SERVICE | — | — | `models/UserSettings.ts:112` (unique) | |
| `UserSettings.privacy.restrictedUsers[]` | CROSS-SERVICE array | — | — | `routes/profileSettings.ts:129-130` (`update['privacy.restrictedUsers'] = privacy.restrictedUsers`) | Not `*Id`-suffixed; array of Oxy user ids a viewer is restricted from. |
| `UserTasteProfile.oxyUserId` | CROSS-SERVICE | — | — | `models/UserTasteProfile.ts:49` (unique) | |
| `UserTasteProfile.artists[].key` | FK (loosely typed, embedded — no enforced discriminator) | `catalog_entities` (artist) | — | `services/recommendations/tasteSignals.ts:70,92`; `services/recommendations/recordPlay.ts:189` (`bump(profile.artists, artistId, …)`) | The generic `ITasteWeight.key: string` shape is reused for both `genres` (a plain genre string, NOT-A-ROW-ID) and `artists` (a real `catalog_entities` id) — same field name, two different meanings depending on which array it sits in. Only the `artists` array is a relation. |
| `UserTasteProfile.genres[].key` | NOT-A-ROW-ID | — | — | `services/recommendations/tasteSignals.ts:71,94`; `services/recommendations/recordPlay.ts:188` (`bump(profile.genres, genre, …)`) | A lowercase genre string (e.g. `"jazz"`), not an id — see caveat above. |

### UserUpload

| source | class | target | ON DELETE | proof | note |
|---|---|---|---|---|---|
| `UserUpload.ownerOxyUserId` | CROSS-SERVICE | — | — | `models/UserUpload.ts:155,245,256,269,284` (indexed throughout) | |
| `UserUpload.credits[].catalogEntityId` | FK (dead) | `catalog_entities` | SET NULL | See "dead readers" table above | |
| `UserUpload.matchedTrackId` | FK | `tracks` | SET NULL | `controllers/uploads.controller.ts:2338,2403,2516-2517` (set at promote time; guards re-promotion) | Set once the locker copy is matched/promoted to a public `Track`; the upload row is deliberately **kept**, pointed at the new track (model doc comment: "The locker copy is KEPT and pointed at the new track through `matchedTrackId`"). |
| `UserUpload.resolvedArtistId` | FK | `catalog_entities` (artist) | SET NULL | `controllers/uploads.controller.ts:194,1749,2517` | Set alongside `matchedTrackId` at promotion. |

## Total count and classification breakdown

Counted by parsing every row of every per-model table above (script: iterate each
`### Model` section's `| source | class | target | ON DELETE | proof | note |`
table, tally the `class` column; excludes the two explicit non-rows —
`CatalogEntity(artist).strikes[]._id` and `ModerationOutbox.payload.{…}`, both
marked above as "not a real row" the moment they're introduced).

| classification | count |
|---|---|
| **FK** (including polymorphic, out-of-process-resolved, and dead-write-path cases) | 52 |
| **CROSS-SERVICE** | 40 |
| **EXTERNAL** | 29 |
| **NOT-A-ROW-ID** | 3 |
| **Total relation rows in this document** | **124** |

This is larger than the raw "89 loose `*Id` columns" figure because it also
counts: the 6 declared `ref:` columns, the 5 `Library` array relations (not
`*Id`-named at all), `Podcast.podcastIndexId`/`appleCollectionId` (`Number`-typed,
outside the String-only scan), `Podcast.feedUrl`/`podcastGuid` (external join
keys with no `Id` in the name), and roughly two dozen relation columns
(`resolvedBy`, `removedBy`, `createdBy`, `host`, `createdByAdmin`, `reporter`,
`uploadedBy`, `userId`, `participants`, `speakers`, `participantIds`,
`restrictedUsers`, `queue`, …) that only reading the controllers surfaced,
because none of them end in `Id`.

## Summary for the six schema tasks

- Every **FK** row above should become a real `references()` constraint (or a
  `DEFERRED_FOREIGN_KEYS` entry, per `task-1-brief.md`'s registry pattern, when its
  parent table hasn't landed yet in that task's migration order) with the `ON
  DELETE` behaviour given.
- Every **CROSS-SERVICE**, **EXTERNAL**, and **NOT-A-ROW-ID** row should go into
  `ID_COLUMNS_WITHOUT_FOREIGN_KEY` with the reason column from this table.
- The 4 polymorphic groups (`CatalogRelation.sourceId/targetId`,
  `Report.reportedId`, `ModerationEnforcement.subjectId`,
  `Room.podcastQueue[]`) and the 1 undiscriminated one (`TrackKey.trackId`) need
  an explicit decision from whichever schema task owns them — they cannot be
  auto-classified by the `findIdColumnViolations` gate as a simple FK, and
  should not be force-fit into one.
