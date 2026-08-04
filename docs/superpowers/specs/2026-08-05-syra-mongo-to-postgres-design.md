# Syra: MongoDB → PostgreSQL

**Status:** design, approved 2026-08-05.
**Depends on:** [`2026-08-05-oxyhq-db-extraction-design.md`](./2026-08-05-oxyhq-db-extraction-design.md).
Syra consumes `@oxyhq/db` from its first commit and never writes its own copy of
the plumbing.

**Ecosystem precedent:** oxy-api's `packages/api/src/db/MIGRATION-CONTRACT.md`
and `schema/CONVENTIONS.md` (in the OxyHQServices repo — named rather than
linked, since it is not a path in this one) hold the reasoning behind the
ecosystem-wide rules. This spec holds Syra's deltas. Where the two disagree, the
disagreement is deliberate and stated here.

Stack: Drizzle ORM over `postgres.js`, migrations applied by the deploy itself.
Package manager: bun only.

## Two prime directives, carried over

1. **No relational link may be lost.**
2. **No Mongo baggage travels.** Designed as if Postgres had always been the
   choice, not transliterated.

When they conflict, stop and escalate rather than resolving it silently.

Syra's first directive is harder than oxy-api's, and for a reason worth stating
up front: **Syra declares only 7 `ref:` in 41 models.** Nearly every relation is
a loose string id — `artistId`, `trackId`, `oxyUserId` — that Mongoose never
checked and that no schema records. The relation graph therefore has to be
recovered by reading call sites, not by reading models. A schema-only port would
be silently link-lossy while looking complete.

## Decision: clean start, no backfill

Production data is **not** migrated. Postgres starts empty.

This is the single decision that makes Syra's port smaller than oxy-api's, and
it removes, rather than defers, a whole subsystem: no `backfill/` directory, no
collection→table map, no round-trip tests, no referential-integrity reconstruction
across loose ids, no orphan-resolution plans.

What it costs, accepted knowingly: existing users lose library, playlists,
listening history and uploads. The music catalogue is already empty by design
(creator-uploads-only since 2026-07-20), and podcasts are a mirror of external
RSS that re-derives itself. Uploaded audio already in S3 becomes orphaned and is
swept separately.

**The consequence that shapes everything else: ids are uuid v7 from the first
row.** No 24-char ObjectId hex is preserved, because there is nothing to
preserve. oxy-api had to keep `text` columns holding ObjectId hex verbatim so
that every undeclared foreign key survived; Syra has no such constraint.

## Wire contract

`_id` disappears; the field is `id`. It is declared in 9 `shared-types` DTOs and
consumed by the published `@syra.fm/sdk` (`RecordingsPanel`), so this is a real
API change, taken as a clean cut with no compatibility alias — consistent with
the repo's standing rule against back-compat shims.

**Everything else in the wire format stays put.** Frontend, studio and SDK are
updated in the same pull request as the vertical that changes them, never in a
sweep afterwards.

**92 `ObjectId.isValid` call sites in `src/` are deleted, not ported.** They
exist only to prevent a Mongoose `CastError`; a Postgres `text` id simply matches
no rows. Each site is reviewed rather than swept: where a 400 is a documented
contract, an explicit uuid-format validation stays; everywhere else a malformed
id now returns 404. Some sites branch on the result rather than merely rejecting,
and those are the ones that change behaviour if swept blindly.

## Schema decisions specific to Syra

### `oxy_user_id` never carries a foreign key

It is a cross-service id owned by oxy-api. It goes in the "declared to never
carry an FK" registry, so that a NEW unclassified `*_id` column fails the gate
while this one passes deliberately.

### `Library` ceases to exist as a table

Its five arrays — `likedTracks`, `savedAlbums`, `followedArtists`,
`savedPlaylists`, `subscribedPodcasts` — become five junction tables, each with a
real FK to its target and an unconstrained `oxy_user_id`. With the arrays gone
the document has nothing left in it: it was only ever a container Mongo forced.

### `CatalogEntity`: one table, explicit `type`

A Mongoose single-collection-inheritance discriminator (`artist` | `person`)
becomes one `catalog_entities` table: `type` as `text` with a CHECK, per-type
columns nullable, `linked_artist_id` a self-referencing FK plus a CHECK that
forbids populating it unless `type = 'person'`.

This **eliminates a known bug class rather than porting it**: `aggregate()` does
not apply the discriminator's `type` scope, so every pipeline has to remember an
explicit `$match`. In Postgres the `where type = …` is always explicit and a
missing one is visible in the query.

### Subdocument arrays become child tables

`Episode.transcripts` / `.persons` / `.hls`, `Playlist.collaborators`,
`Podcast.funding`, `Lyrics.lines`, `House.members`, `MusicBrainzArtist.urls`, and
the `SourceProvenance` array on Album / Playlist / Podcast.

### Scalar arrays stay arrays — except where the app must enumerate them

- `PlaybackState.queue` and `Device.capabilities` → native `text[]`. Read whole,
  never queried by element; a child table would be over-normalization.
- **`Album.genre` and `Podcast.categories` do NOT become `text[]`.** Both are
  indexed today and genre cards browse by them — and browsing requires
  *enumerating* the genres that exist, which is exactly what an array cannot
  answer. A `genres` table plus a junction.

### The three `Mixed` fields

`ModerationOutbox.payload` and `ModerationEvent.payload` are genuinely
shape-less event envelopes → `jsonb`.

`Podcast.value` is the Podcasting 2.0 `<podcast:value>` block. It has a shape,
but that shape belongs to an external specification and Syra never reads into it
— `podcastSerializers.ts:102` passes `doc.value` straight through and nothing
else touches it. It stays `jsonb` as verbatim pass-through, and that reason is
recorded so a future reader does not mistake it for a dumping ground. The moment
any code reads a field inside it, it earns real columns.

### Text search

The 7 Mongo `text` indexes (Album, House, Episode, Playlist, Podcast, Track,
CatalogEntity) become `tsvector` GENERATED columns plus GIN indexes, built with a
**literal** configuration: `to_tsvector('english', …)`. The unqualified form is
STABLE, not IMMUTABLE, and a generated column rejects it. Never `LIKE '%…%'` —
that is a table scan wearing a text index's clothes.

### Expiry replaces the 4 TTL indexes

`NotificationSuppression.expiresAt`, `ModerationOutbox.expiresAt`,
`ModerationEvent.expiresAt` (all `expireAfterSeconds: 0` — the column is the
deadline) and `ListeningEvent.playedAt` (a retention window on a birth column).
Each becomes a registry entry with its supporting btree index. `ListeningEvent`
is the high-volume one and sets the batch size.

**Every read that filters on expiry itself must keep doing so.** Dropping such a
filter because "the sweep handles it" converts a bounded lag into a live stale
read. Any read that relies on the row already being gone gets a read-side filter
added during the port, so no table's correctness depends on a job having run.

### Foreign keys and the loose-id problem

Every relation gets a real constraint with an explicitly decided `ON DELETE`.
Because the relations are not declared in the models, the port produces a written
relation inventory — source column, target table, `ON DELETE`, and the call site
that proves the relation exists — before any table is written. That inventory is
the artefact that discharges directive 1; a schema that compiles is not evidence.

**One cable is already loose and real FKs force a decision:** `Room.topicId`
declares `ref: 'Topic'` and **there is no `Topic` model in the repo.** Mongo never
checked it. Either the table appears or the column goes. It cannot be carried
across.

## What gets deleted rather than ported

- **`toApiFormat`.** It spreads the whole document, which is precisely why
  `select: false` is inert on Syra's aggregation reads today and why a field
  absent from a zod schema still ships. Drizzle enumerates columns: each DTO
  names its fields, and `stripExternalCatalogFields` becomes a protected-column
  registry read through `publicColumns()`.
- **The `$lookup` / `$convert`-on-the-local-side rule.** It exists because an id
  is `string` on one side and `ObjectId` on the other. With real FKs the types
  agree and these are ordinary indexed JOINs. `utils/playableContainers.ts` —
  whose pipelines run the lookup before `$sort`/`$limit`, evaluating every
  container on every request — is the main beneficiary and the place to measure.
- **`andMongoFilters`.** Composing with `$and` so as not to clobber an existing
  `$or` has no counterpart; drizzle composes with `and()`.
- **The transaction fallback.** Where Mongo's helpers re-ran session-less against
  a non-replica-set, Postgres transactions are real. 5 call sites.

## What must survive the port, restated

- **`playableTrackFilter()` and `isTrackPlayable` remain two artefacts** — a
  reusable drizzle condition and an in-memory row predicate — because listing and
  playback are still two authorities. The difference is that agreement between
  them becomes testable against real rows instead of maintained by discipline.
  Any field that hides a track from one must hide it from the other, or takedowns
  stay listed and searchable and then fail at play.
- **`canViewPlaylist()` stays the single predicate** for playlist readability,
  which — unlike track playability — genuinely varies per viewer.
- Identity-sensitive catalog reads keep separate cache keys for `guest` and
  `auth`, and keep waiting on `isPrivateApiPending`.

## Phasing

**Phase 1 — the whole schema, no call sites.** All 41 models' tables, indexes,
CHECKs, real FKs, the relation inventory, and the convention gates from
`@oxyhq/db/assert`. Landing the schema whole is what lets the FKs be real from
the start; slicing it forces deferred FKs and a ledger of promises.

**Phases 2–8 — one vertical per pull request**, each green on its own, each
updating frontend/studio/SDK in the same PR:

| # | vertical | models |
|---|---|---|
| 2 | Music catalogue | Track, Album, CatalogEntity, TrackKey, IsrcRegistry, TrackFingerprint, ImageAsset, Lyrics, MusicBrainzArtist, DiscogsRelease |
| 3 | Library and playlists | Library (→ junctions), Playlist, PlaylistTrack, RecentlyPlayed, PlaybackState, Device |
| 4 | Podcasts | Podcast, Episode, EpisodeProgress |
| 5 | Creators and uploads | UserUpload, ArtistClaim, ContributionAttestation, ContributorStanding, CopyrightReport |
| 6 | Moderation | ModerationEnforcement, ModerationEvent, ModerationOutbox, Report |
| 7 | Rooms and live | House, Room, RoomUserPreference, Recording, Series |
| 8 | User and recommendations | UserSettings, UserMusicPreferences, UserBehavior, UserTasteProfile, ListeningEvent, CatalogRelation, NotificationPreference, NotificationSuppression |

**Phase 9 — removal.** Mongoose, `mongodb-memory-server`, the model directory and
`MONGODB_URI` leave in one deliberate change, after the last vertical.

## Infrastructure

- Database `syra` on the shared `oxy-postgres` RDS instance, **owned by the
  `syra` role**, created once by the `oxyadmin` master user. Ownership is what
  gives the role `CREATE` on `public` with no `GRANT` anywhere. A probe database
  created by a different role misrepresents production's permissions in both
  directions.
- **No PostGIS.** Syra has no `2dsphere` index and no spatial query, so the
  privileged-extension precondition that bites Mention does not apply. Local and
  CI run plain `postgres:17`.
- `/oxy/syra/DATABASE_URL` in SSM with `?sslmode=require` (the parameter group
  sets `rds.force_ssl = 1`), plus the entry in the `syra` module in
  `app-services.tf`.
- **`deploy-aws.yml` enumerates secrets explicitly.** `DATABASE_URL` must appear
  both in the sync block and in `SSM_SECRET_ALLOWLIST`, or the sync silently
  never writes it and new tasks crash-loop with `ResourceInitializationError`.
  Inject it **before** the port ships, against an image that still ignores it —
  the ordering is cheaper to get wrong then.
- **The deploy applies migrations itself**, `pre` before the rollout and `post`
  after, using oxy-api's deploy-phase mechanism. That mechanism exists because of
  a real outage: a migration and the code reading its column merged together, the
  image reached production and the column did not, and `POST /users/by-ids`
  returned 500 ecosystem-wide until someone dispatched the migration by hand.
  Expand and contract go in separate migrations; a file that adds one column and
  drops another has no correct side.
- `MONGODB_URI` is removed in phase 9, never in the same deploy as the cutover.

## Verification

**Inherited gates** (`@oxyhq/db/assert`): schema invariants, `*_id`
classification, protected columns plus the implicit-whole-row-read scanner,
supporting index for every swept column.

**Syra's own gate, rebuilt rather than inherited.** `zodPathsExistInMongoose.test.ts`
exists because Mongoose strict mode drops a `$set` on an undeclared path with no
throw and no warning: tsc clean, logs report success, database keeps nothing.
Postgres fails loudly on a missing column — but **a DTO field that no code maps
to a column still fails to persist just as silently**. The test changes engine;
it does not go away. Its detector stays an **idempotency check** — write, re-read,
compare — because asserting the return value reports success either way.

**Before any push:** backend `bun test`, tsc, `expo export`, and `docker build`.
tsc and tests green is not CI green in this repo.

**Measurement, not assertion.** `log_min_duration_statement = 1000` is already
set on the parameter group for exactly this: a query that was cheap against
Mongo's access pattern and expensive against a relational one is what this port
has to surface. The home feed's history here (22s against a 5s client abort)
makes it the first thing to measure after phase 2, not the last.

**Mutation-test load-bearing assertions.** Break the thing a test guards, confirm
it goes red AND names the offending path, then restore in place. And per this
repo's recorded finding: a fixture set that sits entirely on one side of the
distinction a check exists to make cannot tell the strict version from the loose
one.

## Open items to resolve during planning, not silently

1. `Room.topicId` → the missing `Topic` model: table or column removal.
2. Whether the published `@syra.fm/sdk` major version bumps on the `_id` → `id`
   change, and who its external consumers are.
3. Orphaned S3 audio from uploads whose rows are not migrated — swept how, and by
   what.
