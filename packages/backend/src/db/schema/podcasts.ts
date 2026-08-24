/**
 * Podcasts schema — `podcasts` and `episodes`, and everything that belongs to
 * either of them.
 *
 * Ported from `packages/backend/src/models/{Podcast,Episode,
 * EpisodeProgress}.ts`, field by field, against
 * `packages/backend/docs/db/RELATIONS.md` for every foreign key.
 *
 * ## `Podcast.value` stays `jsonb`
 *
 * It is the Podcasting 2.0 `<podcast:value>` block (value-for-value payment
 * splits). `services/podcasts/podcastSerializers.ts:102` passes `doc.value`
 * straight through to the API response with no code reading a field inside
 * it — the moment something reads into it, it earns real columns. Recorded
 * here so a later reader does not mistake this for a dumping ground.
 *
 * ## `Podcast.categories` joins `genres` through a junction
 *
 * Same reasoning as `Album.genre` (`catalog.ts`): a Postgres `text[]` can
 * answer "does this row contain X" but not "what categories EXIST", which
 * `browsePodcasts`' category filter needs to be able to enumerate.
 * `podcast_categories` is the junction, against the same `genres` table
 * Task 2 built. **Update, Task 4 review (I7):** `genres.ts`'s doc comment
 * originally said this table would carry no podcast-specific vocabulary —
 * that turned out wrong the moment this junction landed against it, and
 * `genres` now carries a `kind` discriminator (`'music' | 'podcast'`)
 * precisely because it serves both. See `genres.ts`'s file-level doc comment
 * for the full reasoning and `podcast_categories`, below, for the composite
 * FK that enforces it.
 *
 * ## Which subdocument arrays became child tables
 *
 * The brief names six: `Episode.transcripts`, `Episode.persons`,
 * `Episode.hls` (`models/Episode.ts:117-123`), and `Podcast.funding`,
 * `Podcast.persons`, `Podcast.sources`. All six land here as real child
 * tables — `podcast_funding`, `podcast_persons`, `podcast_sources`,
 * `episode_transcripts`, `episode_persons`, `episode_hls_renditions` — each
 * with an ordinal `position` column, matching every other array-turned-table
 * in this schema (`track_credits.position`, `track_sources.position`, …).
 *
 * **`podcast_categories` is the SEVENTH and was missed.** It is a junction
 * rather than a subdocument array, which is why it was reasoned about
 * separately below — but `Podcast.categories` was an ordered `string[]` all the
 * same, and RSS declares the primary category first. It carries `position` as
 * of Task 12; see that column's own comment.
 *
 * Two of the six have real query-by-element evidence beyond the brief's own
 * instruction: `services/podcasts/resolvePersons.ts`'s `strongKeyCreditMatch`
 * runs `persons: { $elemMatch: { linkedOxyUserId } }` (falling back to
 * `href`, then a case-insensitive exact `name`) to power the "appears in"
 * shelf on a person's profile (`entityProfile.controller.ts:169-179`) — so
 * `podcast_persons`/`episode_persons` both get real indexes on
 * `linked_oxy_user_id` and `href`. `Podcast.sources` has NO writer anywhere
 * in this codebase (confirmed by grep), but it is built as a real table
 * here regardless because the brief names `podcastSources` explicitly in its
 * `Produces` list — flagged, not resolved unilaterally.
 *
 * The comparison this sentence used to draw — "the same shape catalog.ts's own
 * report found in `CatalogEntity.members[]`" — is REMOVED, not reworded:
 * `members` is written by `services/uploads/enrichCatalogEntity.ts`, so it was
 * never an example of a read half with no write half. Task 10b measured that;
 * see its report. `Podcast.sources` having no writer stands on its own grep and
 * did not need the analogy.
 *
 * `Episode.hls` becoming a child table was, in this file's first pass, a
 * departure from `catalog.ts`'s own THEN-precedent: `tracks.hls` stayed
 * `jsonb` there (no query-by-element evidence). That inconsistency is
 * RESOLVED, not merely noted — a Task 4 follow-up found that neither array is
 * actually queried by element in the database (every reader loads the parent
 * document and filters in JavaScript), so the real justification for a child
 * table here is `catalog.ts`'s OTHER rule: an array of objects with a known,
 * shared shape (`HlsRenditionSchema`, identical on both `models/Track.ts:185`
 * and `models/Episode.ts:123`) becomes a child table regardless of
 * query-by-element evidence. `catalog.ts` was corrected to match:
 * `tracks.hls` is gone, replaced by `track_hls_renditions` (see that table's
 * own comment in `catalog.ts` for the full reasoning). `episode_hls_renditions`
 * and `track_hls_renditions` are now genuinely symmetric siblings, not one
 * considered choice and one exception.
 *
 * `Episode.chapters` and `Episode.cache` and both models' `audioSource` are
 * NOT in that list — each is a single subdocument (not an array), so each
 * stays flattened onto the parent row, the same treatment `catalog.ts` gives
 * `Track.metadata`/`Track.audioSource`. Every flattened column from an
 * optional-as-a-whole subdocument is nullable with NO default, even when the
 * Mongoose sub-schema declares one on an inner field (`cache.status` defaults
 * to `'none'` in Mongo, but `cache` itself may be entirely absent) — this
 * mirrors `tracks.audioSourceUrl`/`audioSourceFormat`/… in `catalog.ts`
 * exactly, which are bare nullable columns despite `AudioSourceSchema`
 * declaring some of its own fields `required: true`.
 *
 * `Episode.hlsMasterKey` (top-level, the primary/Syra-hosted stream) and
 * `Episode.cache.hlsMasterKey` (the hybrid-cache pipeline's own key) are two
 * DIFFERENT fields in Mongo — flattened here as `hlsMasterKey` and
 * `cacheHlsMasterKey` so neither collides with or shadows the other.
 *
 * ## Two `tsvector` GENERATED columns
 *
 * `podcasts(title, author)` and `episodes(title)`, both `to_tsvector('english',
 * …)` with a literal configuration (the one-argument form is STABLE, which a
 * generated column rejects) — the same GIN-search treatment `catalog.ts` and
 * `library.ts` give every browsable table. `author` is nullable, so its
 * expression is `title || ' ' || coalesce(author, '')`, the same `coalesce`
 * `playlists.searchVector` (`library.ts`) uses for its own nullable
 * `description`. `searchPodcasts` reads via a Mongo case-insensitive regex
 * today, not `$text` (its own comment: production `autoIndex` is off) — this
 * table still gets the GIN, matching `catalog.ts`'s systematic policy of one
 * per browsable table regardless of whether the current read path uses it
 * yet.
 *
 * ## `podcasts.status` is NOT dropped — it got the index its NEGATION needs
 *
 * Reviewed and corrected: the first pass through this file left
 * `podcasts.status` off the drop list below AND gave it no Postgres index,
 * which was simply wrong, not a considered drop — all three `status`-bearing
 * indexes on `podcasts` are partial `WHERE status = 'active'`, and none can
 * serve `status <> 'active'`. That negation is a real, per-request reader:
 * `utils/podcastDiscovery.ts`'s `hiddenShowEpisodeFilter()` runs `find({
 * status: { $ne: 'active' } })` on every credit-listing and search request
 * (its own doc comment names the Mongo `status` index it depends on).
 * `podcasts_inactive_idx`, on the table below, is the fix — see that index's
 * own comment for why it indexes `id` alone rather than a sort key.
 *
 * ## Indexes dropped, and why
 *
 * Every drop below replaces a Mongo `index: true` (or a Mongo `'text'`
 * index) with NOTHING, because tracing the real call sites found no reader
 * that benefits from it standing alone:
 *
 *  - `podcasts.title` / `podcasts.author` standalone ascending indexes, and
 *    `episodes.title`'s — superseded by the two `tsvector` GIN indexes above.
 *  - `podcasts.source` standalone — every real query filters it alongside
 *    `status` (`podcastRefreshScheduler.ts`'s `{ source: 'rss', status:
 *    'active' }`), covered by the compound partial index built for that
 *    query below; same reasoning `catalog.ts` used to drop `tracks.isExplicit`.
 *  - `podcasts.podcastIndexId` / `podcasts.appleCollectionId` standalone —
 *    grepped across backend, frontend, and studio: neither is ever the
 *    subject of a `find`/`findOne`. `PodcastDirectory.ts`'s own comment says
 *    dedup is keyed by `feedUrl`, then `podcastGuid` — never these two.
 *  - `podcasts.claimable` standalone — read only off an already-loaded single
 *    document (`podcasts.controller.ts:618`), never a query filter.
 *  - `podcasts.needsDeepImport` standalone — the one place it is queried
 *    (`podcastBackgroundImport.ts:191-197`) is already bounded by `feedUrl:
 *    { $in: feedUrls }` against the unique `feed_url` index, over a small,
 *    caller-supplied candidate list; a second index buys nothing there.
 *  - `podcasts.claimedByOxyUserId` standalone — same shape as `claimable`,
 *    read only off an already-loaded document. Matches `catalog_entities`'
 *    own silent precedent for the identical field on that table.
 *  - `podcasts.popularity` / `podcasts.lastEpisodeAt` standalone — both
 *    superseded by `podcasts_active_popularity_idx` /
 *    `podcasts_active_last_episode_at_idx` above (grepped: every reader
 *    sorting by either always filters `status: 'active'` first).
 *  - `episodes.status` / `episodes.popularity` / `episodes.pubDate`
 *    standalone — every cross-show listing that sorts by popularity filters
 *    `status: 'ready'` first (`search.controller.ts`, `entityProfile
 *    .controller.ts`), covered by the partial `(popularity desc, pub_date
 *    desc) WHERE status = 'ready'` index below. The one un-gated `pubDate`
 *    reader (`podcastImportService.ts:301`) is scoped to a single
 *    `podcastId` and already served by the `(podcast_id, pub_date desc)`
 *    compound index, which stays NON-partial deliberately — see below.
 *  - `episodes.source` standalone — grepped every reader; it is never a
 *    query filter, only read off an already-loaded document
 *    (`services/podcasts/podcastCache.ts:74`).
 *  - `episode_progress`'s standalone `oxy_user_id` — already the leading
 *    column of both `unique(oxy_user_id, episode_id)` and the partial
 *    `(oxy_user_id, updated_at desc)` index, so a third index would be
 *    redundant. Same "an index dropped in writing" convention `library.ts`
 *    used for `devices.oxy_user_id`.
 *
 * ## `(podcast_id, pub_date desc)` on `episodes` stays NON-partial
 *
 * Unlike the `status = 'ready'` partial index built for the cross-show
 * listing case, this one serves `getPodcast`/`getPodcastEpisodes`
 * (`podcasts.controller.ts`), whose `episodeVisibilityFilter` returns `{}`
 * (every status) for the show's OWNER and `{ status: 'ready' }` for everyone
 * else. A partial index on `status = 'ready'` would silently stop serving the
 * owner's own unpublished-episode view; kept general, matching the original
 * Mongo index exactly.
 *
 * ## `podcast_sources.importedAt` stays `text`, unlike its three siblings
 *
 * `track_sources`/`album_sources`/`catalog_entity_sources`/`playlist_sources`
 * (`catalog.ts`, `library.ts`) all promoted this field to `timestamptz` on
 * real evidence: every one of their call sites writes `new
 * Date().toISOString()`. `Podcast.sources` has no call site at all (see
 * above) — there is no evidence to promote past what Mongoose actually
 * declares (`type: String`), so it stays `text`, matching the declared type
 * rather than assuming the sibling tables' real-instant semantics.
 *
 * ## The deferred ledger
 *
 * `userPodcastSubscriptions.podcastId` (`library.ts`, Task 3) is no longer
 * deferred: `podcasts` exists now, so `library.ts`'s column becomes a real
 * `.references(() => podcasts.id, { onDelete: 'cascade' })` and its
 * `DEFERRED_FOREIGN_KEYS` entry is deleted in the same change.
 *
 * The "podcast-genre junction" the team-lead's brief also named was never a
 * literal ledger entry — `deferredForeignKeys.ts` never held a column for it,
 * because the junction TABLE itself (not just one of its two FKs) did not
 * exist until this task creates it. `podcast_categories` is built directly
 * below, live from the start, against `podcasts` and the `genres` table
 * Task 2 built — `podcastId` a plain single-column `.references()`, `genreId`
 * a COMPOSITE one (`(genre_id, kind) -> genres(id, kind)`) since a Task 4
 * review follow-up (I7). See `genres.ts`'s file-level doc comment for why.
 *
 * `tracks.copyrightReportId` (`catalog.ts`, Task 2) is NOT closed by this
 * task and is not touched here — its parent, `copyright_reports`, is a
 * moderation-vertical table out of this task's scope. The ledger is one
 * entry shorter after this task, not empty; see this task's own report for
 * the full explanation of why the brief's "an empty ledger is the finish
 * line" does not hold here.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import { AUDIO_FORMATS, catalogEntities, imageAssets } from './catalog';
import { genres, GENRE_KINDS } from './genres';

// ── Closed value sets ────────────────────────────────────────────────────
// Same convention as catalog.ts/library.ts: one `as const` tuple per closed
// value set, used both to type the column and to derive its CHECK.

/**
 * `models/Podcast.ts` / `models/Episode.ts` `source` — shared verbatim
 * between the two models (`@syra/shared-types`' `podcastSourceSchema` is
 * imported by BOTH `podcast.ts` and `episode.ts`), so it is declared once
 * here rather than duplicated per table.
 */
export const PODCAST_SOURCES = ['rss', 'syra'] as const;

/**
 * `@syra/shared-types` `podcastProvenanceProviderSchema` — a WIDER, DIFFERENT
 * value set than `catalog.ts`'s `PROVENANCE_PROVIDERS`. Do not conflate the
 * two: a podcast's provenance provider is the feed/directory it came from,
 * not a music-metadata enrichment source.
 *
 * `'alia'` is where a show was AUTHORED, which is a different question from
 * `podcasts.source` (`'rss' | 'syra'`) and deliberately does not touch it:
 * `source === 'syra'` is the owner-write predicate in five places
 * (`uploadEpisode`, `updatePodcast`, `updateEpisode`, `loadOwnedShowOrRespond`,
 * `loadOwnedEpisodeOrRespond`), so a third value there would silently remove
 * write access from every show carrying it. An Alia-authored show IS
 * Syra-hosted; the provenance row records who made it, and
 * {@link podcasts.aiGenerated} records whether a machine did.
 */
export const PODCAST_PROVENANCE_PROVIDERS = ['rss', 'syra', 'podcastindex', 'apple', 'alia'] as const;

/** `@syra/shared-types` `podcastTypeSchema`. */
export const PODCAST_TYPES = ['episodic', 'serial'] as const;

/** `@syra/shared-types` `podcastStatusSchema`. */
export const PODCAST_STATUSES = ['active', 'unavailable', 'removed'] as const;

/**
 * `@syra/shared-types` `podcastVisibilitySchema` — WHO may see a show, which is
 * a different axis from {@link PODCAST_STATUSES}'s WHETHER it is published.
 *
 * The two are orthogonal on purpose and both are enforced: `status` is the
 * platform/creator publish state (a takedown, an unpublish, a live show), and
 * `visibility` is the audience. A `public` show that is `unavailable` is
 * unreachable; so is an `active` show that is `private`. Collapsing them into
 * one column would make "unpublish" and "make private" the same verb, and
 * republishing would have to guess which one the creator meant.
 *
 * Ordered least- to most-visible so the tuple reads as a ladder:
 *
 *   private   owner only, on every surface.
 *   unlisted  reachable by id — a direct link, a shared URL, an already
 *             subscribed listener — but never listed in browse, search or any
 *             discovery shelf.
 *   public    listed and reachable by anyone.
 */
export const PODCAST_VISIBILITIES = ['private', 'unlisted', 'public'] as const;

/** `@syra/shared-types` `episodeTypeSchema`. */
export const EPISODE_TYPES = ['full', 'trailer', 'bonus'] as const;

/** `@syra/shared-types` `episodeStatusSchema`. */
export const EPISODE_STATUSES = ['ready', 'processing', 'failed', 'unavailable'] as const;

/** `@syra/shared-types` `episodeCacheStatusSchema`. */
export const EPISODE_CACHE_STATUSES = ['none', 'cached', 'hls'] as const;

// ── podcasts ──────────────────────────────────────────────────────────────

export const podcasts = pgTable(
  'podcasts',
  {
    id: generatedId(),
    title: text().notNull(),
    description: text(),
    author: text(),
    imageId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    primaryColor: text(),
    secondaryColor: text(),
    /** Original external artwork URL, kept as a fallback when re-hosting fails. */
    imageSourceUrl: text(),
    language: text(),
    // The category LIST is `podcast_categories` (junction, below) — see the
    // file-level doc comment.
    explicit: boolean().notNull().default(false),
    link: text(),
    type: text({ enum: PODCAST_TYPES }).notNull().default('episodic'),
    // ── Feed identity ─────────────────────────────────────────────────────
    feedUrl: text(),
    podcastGuid: text(),
    /** PodcastIndex.org's own directory id — EXTERNAL, not a Syra row. */
    podcastIndexId: integer(),
    /** Apple Podcasts' own directory id — EXTERNAL, not a Syra row. */
    appleCollectionId: integer(),
    // ── Origin ────────────────────────────────────────────────────────────
    source: text({ enum: PODCAST_SOURCES }).notNull(),
    // ── Linking ───────────────────────────────────────────────────────────
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text(),
    claimable: boolean(),
    /** An Oxy account id — no foreign key. Set when the claim is approved. */
    claimedByOxyUserId: text(),
    /** One of the six real `ref:` in the Mongoose model set (RELATIONS.md). */
    linkedArtistId: text().references(() => catalogEntities.id, { onDelete: 'set null' }),
    // ── Refresh / HTTP conditional-GET cache ─────────────────────────────
    lastRefreshedAt: timestamptz(),
    refreshIntervalMin: integer().notNull().default(60),
    etag: text(),
    lastModified: text(),
    episodeCount: integer().notNull().default(0),
    lastEpisodeAt: timestamptz(),
    /**
     * True for a shallow directory-candidate doc awaiting its background deep
     * feed import (episodes + re-hosted cover). See the file-level doc
     * comment for why this has no standalone index here.
     */
    needsDeepImport: boolean().notNull().default(false),
    // ── Signals ───────────────────────────────────────────────────────────
    popularity: integer().notNull().default(0),
    subscriberCount: integer().notNull().default(0),
    status: text({ enum: PODCAST_STATUSES }).notNull().default('active'),
    /**
     * WHO may see this show — the audience axis, beside `status`'s publish
     * axis. See {@link PODCAST_VISIBILITIES} for the ladder and why the two are
     * separate columns.
     *
     * `DEFAULT 'public'` is load-bearing rather than a convenience. Every row
     * that exists when this column lands is already world-readable, and the RSS
     * import path (`services/podcasts/podcastImportService.ts`,
     * `podcastBackgroundImport.ts`) writes shows mirrored from public feeds
     * without naming this column at all — defaulting to `private` would hide
     * the entire mirrored catalogue behind one migration. Only a Syra-hosted
     * show created through `createPodcast` chooses a value.
     */
    visibility: text({ enum: PODCAST_VISIBILITIES }).notNull().default('public'),
    /**
     * Whether this show's content was machine-generated — a DISCLOSURE, not a
     * provenance record and not an authorization input.
     *
     * Separate from the `provider = 'alia'` row in `podcast_sources` because the
     * two answer different questions and neither implies the other: a human
     * hosts a show and publishes it through Alia (Alia provenance, not AI
     * generated), or a creator generates a show elsewhere and uploads it here
     * (AI generated, no Alia provenance). One column each.
     *
     * `DEFAULT false` for the same reason `visibility` defaults to `'public'`:
     * every row that exists when this lands was made by a person, and claiming
     * otherwise about somebody's show is the worse error.
     */
    aiGenerated: boolean().notNull().default(false),
    // Optional Podcasting 2.0: `funding`/`persons` are child tables below.
    // `value` stays jsonb — see the file-level doc comment.
    value: jsonb().$type<Record<string, unknown>>(),
    // The provenance LOG is `podcast_sources` (child table, below) — see the
    // file-level doc comment for why it is built despite having no writer.
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', title || ' ' || coalesce(author, ''))`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('podcasts_type_check', sql`${t.type} in (${sql.raw(inList(PODCAST_TYPES))})`),
    check('podcasts_source_check', sql`${t.source} in (${sql.raw(inList(PODCAST_SOURCES))})`),
    check('podcasts_status_check', sql`${t.status} in (${sql.raw(inList(PODCAST_STATUSES))})`),
    check(
      'podcasts_visibility_check',
      sql`${t.visibility} in (${sql.raw(inList(PODCAST_VISIBILITIES))})`
    ),
    check('podcasts_popularity_check', sql`${t.popularity} between 0 and 100`),
    // Sparse-unique in Mongo — a plain Postgres `unique()` already tolerates
    // any number of NULLs, the identical semantics.
    unique('podcasts_feed_url_key').on(t.feedUrl),
    unique('podcasts_podcast_guid_key').on(t.podcastGuid),
    index('podcasts_linked_artist_id_idx').on(t.linkedArtistId),
    // "My podcasts" (podcasts.controller.ts:425) — owner sees every status.
    index('podcasts_owner_oxy_user_id_created_at_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    /**
     * Serves BOTH `searchPodcasts`/the aggregate search's 3-key sort
     * (popularity desc, subscriberCount desc, lastEpisodeAt desc) AND
     * `browsePodcasts`' 2-key "popular" sort (popularity desc, subscriberCount
     * desc) as a leading-column prefix of the same index — both real queries
     * filter `status: 'active'` first.
     */
    index('podcasts_active_popularity_idx')
      .on(t.popularity.desc(), t.subscriberCount.desc(), t.lastEpisodeAt.desc())
      .where(sql`${t.status} = 'active'`),
    // browsePodcasts' "recent" sort (podcasts.controller.ts:213).
    index('podcasts_active_last_episode_at_idx')
      .on(t.lastEpisodeAt.desc())
      .where(sql`${t.status} = 'active'`),
    // podcastRefreshScheduler.ts's own compound predicate + sort — a distinct
    // real query from the two above, not covered by either.
    index('podcasts_rss_active_subscriber_count_idx')
      .on(t.subscriberCount.desc(), t.popularity.desc())
      .where(sql`${t.status} = 'active' and ${t.source} = 'rss'`),
    /**
     * The NEGATION of the three indexes above — `status <> 'active'`, not
     * `= 'active'`. `utils/podcastDiscovery.ts`'s `hiddenShowEpisodeFilter()`
     * runs `find({ status: { $ne: 'active' } }).select('_id')` on every
     * credit-listing and search request (called from
     * `entityProfile.controller.ts:167` and the search path); that function's
     * own doc comment says "the extra query uses the indexed `status` field".
     * Indexes `id` alone, not a sort key, because the reader is
     * `.select('_id')` with no `ORDER BY` — smaller than Mongo's full
     * `status` index and an exact match for the query, not a general-purpose
     * one.
     */
    index('podcasts_inactive_idx').on(t.id).where(sql`${t.status} <> 'active'`),
    index('podcasts_search_gin').using('gin', t.searchVector),
  ]
);

// ── podcast_funding (child of podcasts) ─────────────────────────────────────

export const podcastFunding = pgTable(
  'podcast_funding',
  {
    id: generatedId(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    url: text().notNull(),
    message: text(),
  },
  (t) => [
    check('podcast_funding_position_check', sql`${t.position} >= 0`),
    unique('podcast_funding_podcast_id_position_key').on(t.podcastId, t.position),
  ]
);

// ── podcast_persons (child of podcasts — channel-level Hosts & Guests) ──────

export const podcastPersons = pgTable(
  'podcast_persons',
  {
    id: generatedId(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    name: text().notNull(),
    role: text(),
    group: text(),
    /** External avatar URL (RSS persons) — distinct from the `image_assets` pipeline. */
    img: text(),
    href: text(),
    /** An Oxy account id — no foreign key. */
    linkedOxyUserId: text(),
  },
  (t) => [
    check('podcast_persons_position_check', sql`${t.position} >= 0`),
    unique('podcast_persons_podcast_id_position_key').on(t.podcastId, t.position),
    // strongKeyCreditMatch (resolvePersons.ts) — the "appears in" query,
    // strong-key tier. See the file-level doc comment.
    index('podcast_persons_linked_oxy_user_id_idx').on(t.linkedOxyUserId),
    index('podcast_persons_href_idx').on(t.href),
  ]
);

// ── podcast_sources (SourceProvenance child table — see the file-level doc comment) ──

export const podcastSources = pgTable(
  'podcast_sources',
  {
    id: generatedId(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    provider: text({ enum: PODCAST_PROVENANCE_PROVIDERS }).notNull(),
    externalId: text().notNull(),
    /**
     * `text`, not `timestamptz` — this table has no writer at all, unlike its
     * three siblings in `catalog.ts`/`library.ts`. See the file-level doc
     * comment for why this stays exactly what Mongoose declares.
     */
    importedAt: text().notNull(),
    fields: text().array().notNull().default(sql`array[]::text[]`),
  },
  (t) => [
    check(
      'podcast_sources_provider_check',
      sql`${t.provider} in (${sql.raw(inList(PODCAST_PROVENANCE_PROVIDERS))})`
    ),
    check('podcast_sources_position_check', sql`${t.position} >= 0`),
    unique('podcast_sources_podcast_id_position_key').on(t.podcastId, t.position),
  ]
);

// ── podcast_categories (junction, Podcast ↔ genres — see the file-level doc comment) ──

export const podcastCategories = pgTable(
  'podcast_categories',
  {
    id: generatedId(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    /**
     * No inline `.references()` — the FK is the COMPOSITE
     * `(genre_id, kind) -> genres(id, kind)` declared below, not a plain
     * single-column one (Task 4 review, I7). See `genres.ts`'s file-level
     * doc comment: `genres` now serves two verticals, and a single-column FK
     * on `genreId` alone could not stop this row from pointing at a
     * `kind = 'music'` row.
     */
    genreId: text().notNull(),
    /**
     * The category's index in the feed's own list.
     *
     * Added in Task 12, and it closes a Task 4 gap rather than adding a
     * feature: six of this vertical's seven child tables carry `position`
     * (`podcast_funding`, `podcast_persons`, `podcast_sources`,
     * `episode_transcripts`, `episode_persons`, `episode_hls_renditions`) and
     * this one did not, so a `Podcast.categories` string array — which IS
     * ordered, and whose first element is the primary category an RSS feed
     * declares — lost that ordering the moment it became rows.
     *
     * The loss was one-directional: once dropped at import it is not
     * recoverable from the table, and a reader ordering by name later would
     * have no way to know the feed had said something different. Same
     * "identical shape gets identical treatment" rule this schema has been
     * bitten by twice already (`sources`, then `hls`).
     */
    position: integer().notNull(),
    /** Always `'podcast'` on this table — see the CHECK below and `genres.ts`. */
    kind: text({ enum: GENRE_KINDS }).notNull().default('podcast'),
  },
  (t) => [
    check('podcast_categories_kind_check', sql`${t.kind} = 'podcast'`),
    check('podcast_categories_position_check', sql`${t.position} >= 0`),
    unique('podcast_categories_podcast_id_genre_id_key').on(t.podcastId, t.genreId),
    /**
     * A show cannot file the same category twice AND cannot put two categories
     * at the same index — the two uniques constrain different things, and the
     * six sibling tables carry the second one for the same reason.
     */
    unique('podcast_categories_podcast_id_position_key').on(t.podcastId, t.position),
    index('podcast_categories_genre_id_idx').on(t.genreId),
    foreignKey({
      columns: [t.genreId, t.kind],
      foreignColumns: [genres.id, genres.kind],
    }).onDelete('restrict'),
  ]
);

// ── episodes ──────────────────────────────────────────────────────────────

export const episodes = pgTable(
  'episodes',
  {
    id: generatedId(),
    podcastId: text()
      .notNull()
      .references(() => podcasts.id, { onDelete: 'cascade' }),
    /** Denormalized copy of the parent show's title at write time — not itself a reference. */
    podcastTitle: text().notNull(),
    title: text().notNull(),
    description: text(),
    summary: text(),
    guid: text().notNull(),
    // Origin enclosure (RSS); absent for Syra-hosted episodes.
    enclosureUrl: text(),
    enclosureType: text(),
    enclosureLength: integer(),
    duration: doublePrecision().notNull().default(0),
    pubDate: timestamptz().notNull(),
    season: integer(),
    episodeNumber: integer(),
    episodeType: text({ enum: EPISODE_TYPES }).notNull().default('full'),
    imageId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    primaryColor: text(),
    secondaryColor: text(),
    imageSourceUrl: text(),
    explicit: boolean().notNull().default(false),
    // ── Podcasting 2.0: `chapters` is a single optional subdocument, flattened
    // (see the file-level doc comment); `transcripts`/`persons` are child
    // tables below.
    chaptersUrl: text(),
    chaptersType: text(),
    // ── Hybrid audio ──────────────────────────────────────────────────────
    source: text({ enum: PODCAST_SOURCES }).notNull(),
    // `cache` is a single optional subdocument, flattened (see the
    // file-level doc comment). `cacheHlsMasterKey` is DISTINCT from the
    // top-level `hlsMasterKey` below — two different keys in Mongo.
    cacheStatus: text({ enum: EPISODE_CACHE_STATUSES }),
    // Named `cacheObjectKey`, not `cacheS3Key` — the latter tokenizes as
    // `cache_s_3_key` under drizzle's own snake_case casing (`toSnakeCase`,
    // `drizzle-orm/casing.js`): a capital letter immediately followed by a
    // digit splits into its own token, unlike `image_assets.s3Key` (starts
    // the identifier, so it stays fused as `s3_key`). Verified directly
    // against the casing function before choosing this spelling.
    cacheObjectKey: text(),
    cacheHlsMasterKey: text(),
    cacheCachedAt: timestamptz(),
    // `audioSource` is a single optional subdocument, flattened — same
    // treatment (and the same reused `AUDIO_FORMATS` enum) as
    // `tracks.audioSource*` in catalog.ts.
    audioSourceUrl: text(),
    audioSourceFormat: text({ enum: AUDIO_FORMATS }),
    audioSourceBitrate: integer(),
    audioSourceDuration: doublePrecision(),
    // `hls` is a child table (episode_hls_renditions, below).
    hlsMasterKey: text(),
    // ── Signals ───────────────────────────────────────────────────────────
    playCount: integer().notNull().default(0),
    popularity: integer().notNull().default(0),
    status: text({ enum: EPISODE_STATUSES }).notNull().default('ready'),
    /**
     * Per EPISODE, not inherited from the show — see `podcasts.aiGenerated`.
     *
     * A show can mix: a human-hosted series with one machine-generated recap
     * episode has to be able to disclose exactly that episode, and a show-level
     * flag would either over-claim or under-claim for every other one.
     */
    aiGenerated: boolean().notNull().default(false),
    searchVector: tsvector().generatedAlwaysAs(sql`to_tsvector('english', title)`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('episodes_episode_type_check', sql`${t.episodeType} in (${sql.raw(inList(EPISODE_TYPES))})`),
    check('episodes_source_check', sql`${t.source} in (${sql.raw(inList(PODCAST_SOURCES))})`),
    check('episodes_status_check', sql`${t.status} in (${sql.raw(inList(EPISODE_STATUSES))})`),
    check(
      'episodes_cache_status_check',
      sql`${t.cacheStatus} is null or ${t.cacheStatus} in (${sql.raw(inList(EPISODE_CACHE_STATUSES))})`
    ),
    check(
      'episodes_audio_source_format_check',
      sql`${t.audioSourceFormat} is null or ${t.audioSourceFormat} in (${sql.raw(inList(AUDIO_FORMATS))})`
    ),
    check('episodes_popularity_check', sql`${t.popularity} between 0 and 100`),
    // One episode per feed guid, direct port of the Mongo compound unique.
    unique('episodes_podcast_id_guid_key').on(t.podcastId, t.guid),
    // Reverse-chronological listing within a show — NON-partial; see the
    // file-level doc comment for why (the show owner sees every status).
    //
    // Kept even though `episodesByShowQuery` no longer orders by it: it is what
    // `episodeStats`' newest-episode probe, `countReadyEpisodesByShows` and
    // `findEpisodeIdsAwaitingHls` read, and it is the ONLY index that can
    // answer "the latest episode of this show by date" as a one-row probe.
    index('episodes_podcast_id_pub_date_idx').on(t.podcastId, t.pubDate.desc()),
    /**
     * The show's episode LIST, in the order a numbered series needs.
     *
     * `episodesByShowQuery` orders by `episode_number desc nulls last, pub_date
     * desc nulls last`, and without this index that ordering cannot be streamed.
     * Measured on 2,000 episodes of one show
     * (`__tests__/podcasts.explain.test.ts`, the `deepShow*` probes):
     *
     *   with this index      Index Scan, stops at 20      cost   63.13     5 buffers
     *   without it           top-N heapsort of all 2,026  cost 1937.01   108 buffers
     *
     * So it is not a micro-optimisation: without it the cost is a function of
     * the show's SIZE rather than of the page, which is precisely the regression
     * `descNullsLast` exists to avoid everywhere else in this schema.
     *
     * `.desc()` on both keys because drizzle emits that as `DESC NULLS LAST` in
     * an index definition, which is the spelling `descNullsLast` produces in the
     * query — the two have to match or the index is reachable but not
     * streamable.
     *
     * NON-PARTIAL, for the same reason its `pub_date` sibling is: a `status =
     * 'ready'` predicate here would silently stop serving the owner's own
     * unpublished-episode view, which is the one view that sees every status.
     */
    index('episodes_podcast_id_episode_number_pub_date_idx').on(
      t.podcastId,
      t.episodeNumber.desc(),
      t.pubDate.desc()
    ),
    // Cross-show listings (search, "appears in") — public playability gate.
    index('episodes_ready_popularity_idx')
      .on(t.popularity.desc(), t.pubDate.desc())
      .where(sql`${t.status} = 'ready'`),
    index('episodes_search_gin').using('gin', t.searchVector),
  ]
);

// ── episode_transcripts (child of episodes) ─────────────────────────────────

export const episodeTranscripts = pgTable(
  'episode_transcripts',
  {
    id: generatedId(),
    episodeId: text()
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    url: text().notNull(),
    type: text().notNull(),
    language: text(),
  },
  (t) => [
    check('episode_transcripts_position_check', sql`${t.position} >= 0`),
    unique('episode_transcripts_episode_id_position_key').on(t.episodeId, t.position),
  ]
);

// ── episode_persons (child of episodes — per-episode Hosts & Guests) ────────

export const episodePersons = pgTable(
  'episode_persons',
  {
    id: generatedId(),
    episodeId: text()
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    name: text().notNull(),
    role: text(),
    group: text(),
    img: text(),
    href: text(),
    /** An Oxy account id — no foreign key. */
    linkedOxyUserId: text(),
  },
  (t) => [
    check('episode_persons_position_check', sql`${t.position} >= 0`),
    unique('episode_persons_episode_id_position_key').on(t.episodeId, t.position),
    // strongKeyCreditMatch (resolvePersons.ts) — same evidence as podcast_persons.
    index('episode_persons_linked_oxy_user_id_idx').on(t.linkedOxyUserId),
    index('episode_persons_href_idx').on(t.href),
  ]
);

// ── episode_hls_renditions (child of episodes) ──────────────────────────────

export const episodeHlsRenditions = pgTable(
  'episode_hls_renditions',
  {
    id: generatedId(),
    episodeId: text()
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    manifestKey: text().notNull(),
    bitrateKbps: integer().notNull(),
    encrypted: boolean().notNull(),
  },
  (t) => [
    check('episode_hls_renditions_position_check', sql`${t.position} >= 0`),
    unique('episode_hls_renditions_episode_id_position_key').on(t.episodeId, t.position),
  ]
);

// ── episode_progress (per-user playback position — "continue listening") ───

export const episodeProgress = pgTable(
  'episode_progress',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    episodeId: text()
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    positionSec: doublePrecision().notNull().default(0),
    durationSec: doublePrecision().notNull().default(0),
    completed: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One progress record per user per episode — direct port of the Mongo
    // compound unique; also the leading-column index for "this user's
    // progress list", so no separate standalone oxy_user_id index is added
    // (dropped in writing — see the file-level doc comment).
    unique('episode_progress_oxy_user_id_episode_id_key').on(t.oxyUserId, t.episodeId),
    // FK support — cascade-delete lookup by episode_id, not covered by the
    // unique index above (which leads with oxy_user_id).
    index('episode_progress_episode_id_idx').on(t.episodeId),
    // getContinueListening's own filter + sort — a purpose-fit upgrade over
    // Mongo's non-partial (oxyUserId, updatedAt desc) index, same convention
    // Task 2/3 used for playableTrackFilter()/canViewPlaylist().
    index('episode_progress_oxy_user_id_updated_at_idx')
      .on(t.oxyUserId, t.updatedAt.desc())
      .where(sql`${t.completed} = false`),
  ]
);

// ── episode_ingest_tickets (single-use capability to attach audio) ─────────

/**
 * The redemption record of an episode ingest ticket.
 *
 * ## Why a table and not a Redis nonce
 *
 * The ticket is a 24-hour capability minted while a user's Oxy JWT is live and
 * redeemed later by a background worker that has no user credential at all
 * (service-token delegation is dead platform-wide). Its single-use property is
 * therefore the ONLY thing standing between a leaked ticket and an overwrite of
 * somebody's episode audio, and a nonce in Redis does not survive a restart: an
 * eviction, a failover or a deploy would silently make every outstanding ticket
 * replayable, with nothing anywhere reporting that it had happened. This row is
 * the authority, and `consumed_at` is claimed with a conditional `UPDATE`, so
 * two concurrent redemptions of the same ticket are resolved by Postgres rather
 * than by a read-then-write.
 *
 * ## A MISSING row is a refusal, never a pass
 *
 * `redeemIngestTicket` claims `where jti = … and consumed_at is null and
 * expires_at > now()` and treats zero rows as refused. That single rule makes
 * three separate things safe at once: a replay, a forged `jti` that somehow
 * carried a valid signature, and the expiry sweep below deleting a row while its
 * JWT is technically still valid. Nothing about this table can fail OPEN.
 *
 * ## `jti` is UNIQUE, and `id` is still the primary key
 *
 * The brief called for `jti` as the primary key. It is a `unique()` column
 * instead, which is the same guarantee, because every other table in this schema
 * carries `generatedId()` as `id` and the schema-convention gate
 * (`findSchemaInvariantViolations`) is written against that shape. A unique
 * constraint is what the single-use claim actually needs — it is the thing the
 * conditional `UPDATE` keys on.
 */
export const episodeIngestTickets = pgTable(
  'episode_ingest_tickets',
  {
    id: generatedId(),
    /** The JWT's `jti` claim — the capability's identity. */
    jti: text().notNull(),
    episodeId: text()
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    /**
     * The deadline, stored beside the JWT's own `exp` rather than trusted from
     * it. A token is a bearer artefact: whatever it says about its own lifetime
     * is the holder's copy of a claim this row is the record of.
     */
    expiresAt: timestamptz().notNull(),
    /** Null until redeemed. Set by the conditional claim, never by a read-then-write. */
    consumedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('episode_ingest_tickets_jti_key').on(t.jti),
    // FK support — the cascade-delete lookup when an episode is removed.
    index('episode_ingest_tickets_episode_id_idx').on(t.episodeId),
    // The expiry sweep's leading key (`db/expiry.ts`); `gates.test.ts` fails a
    // registered target that has no index whose FIRST key is the swept column.
    index('episode_ingest_tickets_expires_at_idx').on(t.expiresAt),
  ]
);
