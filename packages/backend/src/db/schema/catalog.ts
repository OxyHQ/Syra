/**
 * Catalog schema — `image_assets`, `catalog_entities`, `albums`, `tracks`,
 * and every table that belongs to one of those four.
 *
 * Ported from `packages/backend/src/models/{Track,Album,CatalogEntity,
 * TrackKey,IsrcRegistry,TrackFingerprint,ImageAsset,Lyrics,MusicBrainzArtist,
 * DiscogsRelease}.ts`, field by field, against
 * `packages/backend/docs/db/RELATIONS.md` for every foreign key.
 *
 * ## `CatalogEntity` becomes ONE table
 *
 * Mongoose's `artist`/`person` discriminator scoped queries IMPLICITLY —
 * `ArtistModel.find()` auto-injects `{ type: 'artist' }` — but `aggregate()`
 * does not, and every catalog read in this codebase (`playableContainers.ts`,
 * `findOneArtistWithPlayableTracks`) is an aggregation. That gap is a live bug
 * class this table dissolves: there is no discriminator model here, so every
 * `where type = …` is a call site the reader can see, not an invisible
 * default.
 *
 * ## Image FK columns hold ONLY the id — url/width/height are dropped
 *
 * `coverArtSizes.{small,…}` and `imageSizes.{small,…}` are, in Mongo, six
 * `{ id, url, width, height }` objects per entity. `catalogImageAssets.ts`'s
 * `writeCatalogImage` proves all three non-id fields are pure functions of the
 * `ImageAsset` row the id already points at: `url` is always literally
 * `/api/images/${id}` (the route convention, not stored data), and
 * `width`/`height` are the exact dimensions `storeImageAsset` already wrote
 * onto that same `ImageAsset` row. Carrying a second copy of a value that is
 * 100% derivable from a FK's own target is the kind of denormalization this
 * port does not need to inherit, so each variant is ONE nullable FK column —
 * `cover_art_sizes_small_id`, not four.
 *
 * ## Subdocument arrays: which became child tables, and which did not
 *
 * The spec named three — `Lyrics.lines`, `MusicBrainzArtist.urls`, and the
 * `SourceProvenance` arrays on `Album` and `CatalogEntity` — and left `Track`
 * off that list even though `Track.sources[]` is the identical
 * `SourceProvenanceSchema`. Flagged in the first pass of this file rather than
 * resolved unilaterally; on review this was confirmed as a brief gap, not a
 * deliberate exclusion — `models/Playlist.ts` carries the same shape too, at
 * `sources: [{ type: SourceProvenanceSchema }]`, and belongs to a later task.
 * So `Track` gets `track_sources`, the third sibling of `album_sources` and
 * `catalog_entity_sources`, same shape, no `jsonb` special case.
 *
 * Two more turned out to need child-table treatment on the evidence in this
 * model set, beyond what the spec enumerated:
 *
 *  - `Track.credits[]` — genuinely queried by element in production:
 *    `services/catalog/artistProfile.ts:154` runs
 *    `TrackModel.find({ 'credits.nameKey': nameKey, … })` for "everything this
 *    artist is credited on" (test: `artistProfile.test.ts:219`), and the same
 *    file's doc comment at :31 says the field is indexed *"precisely so this
 *    is a lookup rather than a scan"*. A `jsonb` column cannot serve that with
 *    an index the way `track_credits.name_key` can, so it is a real child
 *    table.
 *  - `CatalogEntity.strikes[]` — not queried by element, but
 *    `RELATIONS.md` requires `strikes[].trackId` to become a real
 *    `.references()` constraint (`SET NULL`, so a track's removal never
 *    erases the strike itself), and a `jsonb` array cannot carry a foreign
 *    key at all. `catalog_entity_strikes` exists because the FK has to live
 *    SOMEWHERE relational, not because the array is queried by element.
 *
 * `CatalogEntity.members[]` (`ArtistMember`) and `DiscogsRelease.credits[]`
 * are the same TYPE of subdocument — `{ name, nameKey, catalogEntityId, … }`
 * — as `Track.credits[]`, but neither has ANY reader querying by element
 * (`members.nameKey` and `DiscogsRelease.credits` are both zero hits outside
 * their own models — see the report), so both stay `jsonb`, unlike
 * `Track.credits[]`.
 *
 * ## `catalogEntityId` is dropped everywhere it was declared
 *
 * Four Mongoose paths declare it (`Track.credits[]`, `UserUpload.credits[]`,
 * `DiscogsRelease.credits[]`, `CatalogEntity.members[]`) and NONE of them is
 * ever written — confirmed in `RELATIONS.md`'s "columns I could not find a
 * reader for" table. `track_credits` (the one of these four that becomes a
 * real table in this task) has no `catalog_entity_id` column; the other three
 * stay `jsonb`, where there is no column to omit in the first place.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  generatedId,
  inList,
  timestamptz,
  tsvector,
  updatedAt,
} from '@oxyhq/db';
import type {
  ArtistImageSuggestion,
  HlsRendition,
  TrackCredit,
  TrackImage,
} from '@syra/shared-types';
import { genres } from './genres';

// ── Closed value sets ────────────────────────────────────────────────────
// `@syra/shared-types` exports `PROVENANCE_PROVIDERS` as a runtime array
// already (imported above); every other enum below is declared only as a
// Mongoose `enum:` list or a bare TypeScript union, so it is hand-written
// here, matching this repo's own convention (`inList`'s doc comment) of one
// `as const` tuple per closed value set that both types the column and
// drives its CHECK.

/** `models/CatalogEntity.ts` `CatalogEntityType`. */
export const CATALOG_ENTITY_TYPES = ['artist', 'person'] as const;

/** `@syra/shared-types` `catalogSourceSchema` — how a recording entered Syra. */
export const CATALOG_SOURCES = ['upload', 'cc'] as const;

/**
 * `@syra/shared-types` `PROVENANCE_PROVIDERS` (`provenanceProviderSchema.options`),
 * re-declared as a literal tuple. `PROVENANCE_PROVIDERS` itself is a runtime
 * export, but `provenanceProviderSchema.options` types as a plain `string[]`
 * on the zod version this repo pins, which `text({ enum })` rejects (it needs
 * `[string, ...string[]]`) — so this is not a second source of truth for the
 * VALUES, only for the TYPE shape; a value added to the zod schema without a
 * matching update here fails the CHECK constraint immediately, loudly, on the
 * next insert of that value, rather than drifting silently.
 */
export const PROVENANCE_PROVIDERS = [
  'upload',
  'cc',
  'musicbrainz',
  'wikidata',
  'wikimedia-commons',
  'cover-art-archive',
  'discogs',
] as const;

/** `@syra/shared-types` `trackStatusSchema`. */
export const TRACK_STATUSES = ['processing', 'ready', 'failed'] as const;

/** `@syra/shared-types` `audioFormatSchema`. */
export const AUDIO_FORMATS = ['mp3', 'flac', 'ogg', 'm4a', 'wav'] as const;

/** `@syra/shared-types` `artistTypeSchema` — MusicBrainz's own classification. */
export const ARTIST_TYPES = [
  'person',
  'group',
  'orchestra',
  'choir',
  'character',
  'other',
] as const;

/** `@syra/shared-types` `artistOriginSchema`. */
export const ARTIST_ORIGINS = ['registered', 'contributed'] as const;

/** `@syra/shared-types` (module-private) `albumTypeSchema`. */
export const ALBUM_TYPES = ['album', 'single', 'ep', 'compilation'] as const;

/** `models/ImageAsset.ts` `ImageAssetOwnerType`. */
export const IMAGE_ASSET_OWNER_TYPES = [
  'upload',
  'artist',
  'track',
  'album',
  'playlist',
  'link',
  'podcast',
  'episode',
] as const;

/** `models/ImageAsset.ts` `CatalogImageProvider` (`CatalogSource | 'rss' | 'syra'`). */
export const CATALOG_IMAGE_PROVIDERS = ['upload', 'cc', 'rss', 'syra'] as const;

/** `models/ImageAsset.ts` `CatalogImageEntity`. */
export const CATALOG_IMAGE_ENTITY_TYPES = [
  'artist',
  'track',
  'album',
  'playlist',
  'podcast',
  'episode',
] as const;

/**
 * `TrackKey.trackId` is polymorphic across three id spaces
 * (`tracks`/`user_uploads`/`episodes`) with NO discriminator column in Mongo —
 * `services/ingest/hlsStorage.ts`'s own comment is the only place that says
 * so. Added here rather than left unconstrained: a real column beats a column
 * that does not exist, even though only the `track` arm can carry an actual
 * `.references()` today (`user_uploads` and `episodes` land in later tasks —
 * see `deferredForeignKeys.ts`).
 */
export const TRACK_KEY_KINDS = ['track', 'user_upload', 'episode'] as const;

// ── image_assets ─────────────────────────────────────────────────────────

export const imageAssets = pgTable(
  'image_assets',
  {
    id: generatedId(),
    s3Key: text().notNull(),
    filename: text().notNull(),
    contentType: text().notNull(),
    byteSize: integer().notNull(),
    width: integer(),
    height: integer(),
    ownerType: text({ enum: IMAGE_ASSET_OWNER_TYPES }).notNull(),
    /** An Oxy account id — no foreign key. Not `*_id`-suffixed. */
    uploadedBy: text(),
    primaryColor: text(),
    secondaryColor: text(),
    // `ImageAssetCatalogMetadata`, flattened: it is queried by its OWN fields
    // (`catalog.provider`+`entityType`+`externalId`+`size` is a compound
    // Mongo index; `catalog.sourceContentHash` is a second one), so it needs
    // real indexed columns, not an opaque jsonb blob.
    catalogProvider: text({ enum: CATALOG_IMAGE_PROVIDERS }),
    catalogEntityType: text({ enum: CATALOG_IMAGE_ENTITY_TYPES }),
    /** The mirrored image's id at its origin provider — EXTERNAL, not a Syra row. */
    catalogExternalId: text(),
    catalogSize: text(),
    catalogSourceUrlHash: text(),
    catalogSourceContentHash: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('image_assets_s3_key_key').on(t.s3Key),
    check(
      'image_assets_owner_type_check',
      sql`${t.ownerType} in (${sql.raw(inList(IMAGE_ASSET_OWNER_TYPES))})`
    ),
    check(
      'image_assets_catalog_provider_check',
      sql`${t.catalogProvider} is null or ${t.catalogProvider} in (${sql.raw(inList(CATALOG_IMAGE_PROVIDERS))})`
    ),
    check(
      'image_assets_catalog_entity_type_check',
      sql`${t.catalogEntityType} is null or ${t.catalogEntityType} in (${sql.raw(inList(CATALOG_IMAGE_ENTITY_TYPES))})`
    ),
    index('image_assets_uploaded_by_idx').on(t.uploadedBy),
    index('image_assets_catalog_lookup_idx').on(
      t.catalogProvider,
      t.catalogEntityType,
      t.catalogExternalId,
      t.catalogSize
    ),
    index('image_assets_catalog_source_content_hash_idx').on(t.catalogSourceContentHash),
  ]
);

// ── catalog_entities ─────────────────────────────────────────────────────

export const catalogEntities = pgTable(
  'catalog_entities',
  {
    id: generatedId(),
    type: text({ enum: CATALOG_ENTITY_TYPES }).notNull(),

    // ── Base fields (both types) ─────────────────────────────────────────
    name: text().notNull(),
    /** Derived from `name` by application code (`normalizeNameKey`) — never DB-enforced. */
    nameKey: text(),
    imageId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    imageSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    /** `ImageLicence` for the CURRENT `image`, flattened — see `albums.coverArtLicence*`. */
    imageLicenceLicence: text(),
    imageLicenceLicenceUrl: text(),
    imageLicenceAttribution: text(),
    imageLicenceSourceUrl: text(),
    primaryColor: text(),
    secondaryColor: text(),
    bio: text(),
    linksWebsite: text(),
    linksInstagram: text(),
    linksX: text(),
    linksYoutube: text(),
    linksDiscogs: text(),
    linksWikidata: text(),
    linksWikipedia: text(),
    linksBandcamp: text(),
    linksSoundcloud: text(),
    popularity: integer().notNull().default(0),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text(),
    claimable: boolean(),
    /** An Oxy account id — no foreign key. */
    claimedByOxyUserId: text(),
    /** An Oxy account id — no foreign key. Strong dedup key for persons. */
    linkedOxyUserId: text(),
    /** Stable `<podcast:person>` URL identity — strong dedup key for persons. */
    href: text(),
    /**
     * Provider-supplied images, server-only — `stripExternalCatalogFields`
     * (`utils/musicHelpers.ts`) deletes `formatted.images` from every catalog
     * API response. See `PROTECTED_COLUMNS_BY_TABLE` in `protectedColumns.ts`.
     * Declared on the base only because the column is shared; Mongoose only
     * ever populates it on the `artist` discriminator.
     */
    images: jsonb().$type<TrackImage[]>(),

    // ── Artist-only (nullable: a person row never populates these) ───────
    // Where Mongoose declared a `default:`, the same default is kept here —
    // it fires only when an INSERT omits the column, so a person row that
    // never sets these stays exactly as absent as it is in Mongo today; an
    // artist row that omits them at insert time gets the identical default
    // Mongoose would have applied.
    genres: text().array().default(sql`array[]::text[]`),
    verified: boolean().default(false),
    statsFollowers: integer().default(0),
    statsAlbums: integer().default(0),
    statsTracks: integer().default(0),
    statsTotalPlays: integer().default(0),
    statsMonthlyListeners: integer().default(0),
    strikeCount: integer().default(0),
    uploadsDisabled: boolean().default(false),
    lastStrikeAt: timestamptz(),
    terminated: boolean().default(false),
    terminatedAt: timestamptz(),
    terminationReason: text(),
    source: text({ enum: CATALOG_SOURCES }),
    externalIsrc: text(),
    externalMusicbrainzArtistId: text(),
    externalIsni: text(),
    externalIpi: text(),
    externalWikidataId: text(),
    externalDiscogsArtistId: text(),
    country: text(),
    sortName: text(),
    disambiguation: text(),
    artistType: text({ enum: ARTIST_TYPES }),
    activeFrom: text(),
    activeUntil: text(),
    aliases: text().array().default(sql`array[]::text[]`),
    labels: text().array().default(sql`array[]::text[]`),
    origin: text({ enum: ARTIST_ORIGINS }).default('registered'),
    acceptsContributions: boolean().default(false),
    /**
     * Candidate profile photos — server-only, claim-flow-only. Mongoose
     * `select: false`; see `PROTECTED_COLUMNS_BY_TABLE`. `sourceUploadId`
     * inside each entry is a FK (dead write path, `RELATIONS.md`) to
     * `user_uploads`, which has not landed yet — left as an opaque jsonb
     * field rather than a constrained column, since the one function that
     * ever wrote one has zero callers in production.
     */
    imageSuggestions: jsonb().$type<ArtistImageSuggestion[]>(),

    // ── Person-only (nullable) ────────────────────────────────────────────
    /** Links a person to a `type:'artist'` row — see the discriminator CHECK below. */
    linkedArtistId: text().references((): AnyPgColumn => catalogEntities.id, {
      onDelete: 'set null',
    }),
    /** External avatar URL (RSS persons) — distinct from `image`, which is an `image_assets` id. */
    img: text(),

    searchVector: tsvector().generatedAlwaysAs(sql`to_tsvector('english', name)`),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('catalog_entities_type_check', sql`${t.type} in (${sql.raw(inList(CATALOG_ENTITY_TYPES))})`),
    /**
     * The discriminator CHECK the brief names explicitly: `linked_artist_id`
     * is meaningless — and forbidden — on anything but a `person` row.
     */
    check(
      'catalog_entities_linked_artist_id_check',
      sql`${t.linkedArtistId} is null or ${t.type} = 'person'`
    ),
    check(
      'catalog_entities_source_check',
      sql`${t.source} is null or ${t.source} in (${sql.raw(inList(CATALOG_SOURCES))})`
    ),
    /**
     * The SECOND discriminator CHECK, missed in the first pass: `source` is
     * `required: true` on `ArtistDiscriminatorSchema` (`models/CatalogEntity.ts:349`)
     * — required for artists, absent by construction for persons (the field
     * does not exist on `PersonDiscriminatorSchema` at all). Same shape as
     * `linked_artist_id` above (a per-type requirement a plain `NOT NULL`
     * cannot express on a shared column), and it needed the identical CHECK
     * pattern applied to it too.
     */
    check(
      'catalog_entities_source_required_for_artist_check',
      sql`${t.type} != 'artist' or ${t.source} is not null`
    ),
    check(
      'catalog_entities_artist_type_check',
      sql`${t.artistType} is null or ${t.artistType} in (${sql.raw(inList(ARTIST_TYPES))})`
    ),
    check(
      'catalog_entities_origin_check',
      sql`${t.origin} is null or ${t.origin} in (${sql.raw(inList(ARTIST_ORIGINS))})`
    ),
    check('catalog_entities_strike_count_check', sql`${t.strikeCount} is null or ${t.strikeCount} >= 0`),
    unique('catalog_entities_linked_oxy_user_id_key').on(t.linkedOxyUserId),
    unique('catalog_entities_href_key').on(t.href),
    unique('catalog_entities_external_musicbrainz_artist_id_key').on(t.externalMusicbrainzArtistId),
    /**
     * ONE artist per normalised name — partial, ARTISTS only. Persons dedup by
     * strong keys (`linkedOxyUserId`/`href` above) and legitimately share a
     * name with each other or with an artist.
     */
    uniqueIndex('catalog_entities_artist_name_key_key')
      .on(t.nameKey)
      .where(sql`${t.type} = 'artist'`),
    index('catalog_entities_type_name_key_idx').on(t.type, t.nameKey),
    index('catalog_entities_popularity_idx').on(t.popularity.desc()),
    index('catalog_entities_owner_oxy_user_id_idx').on(t.ownerOxyUserId),
    index('catalog_entities_stats_followers_idx').on(t.statsFollowers.desc()),
    index('catalog_entities_verified_popularity_idx').on(t.verified, t.popularity.desc()),
    index('catalog_entities_linked_artist_id_idx').on(t.linkedArtistId),
    index('catalog_entities_search_gin').using('gin', t.searchVector),
  ]
);

// ── albums ────────────────────────────────────────────────────────────────

export const albums = pgTable(
  'albums',
  {
    id: generatedId(),
    title: text().notNull(),
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'restrict' }),
    artistName: text().notNull(),
    /** A string, not a Date — MusicBrainz release dates are routinely partial (a bare year). */
    releaseDate: text().notNull(),
    /**
     * REQUIRED — an album is not created at all unless real cover art was
     * found; see `models/Album.ts`'s own comment. RESTRICT, not SET NULL: a
     * NOT NULL FK cannot tolerate its target disappearing out from under it.
     */
    coverArtId: text()
      .notNull()
      .references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    coverArtSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'restrict' }),
    /** Licence + authorship of `coverArt` when it came from Cover Art Archive. */
    coverArtLicenceLicence: text(),
    coverArtLicenceLicenceUrl: text(),
    coverArtLicenceAttribution: text(),
    coverArtLicenceSourceUrl: text(),
    totalTracks: integer().notNull().default(0),
    totalDiscs: integer(),
    totalDuration: doublePrecision().notNull().default(0),
    type: text({ enum: ALBUM_TYPES }).notNull().default('album'),
    label: text(),
    catalogNumber: text(),
    media: text(),
    releaseCountry: text(),
    originalReleaseDate: text(),
    copyright: text(),
    upc: text(),
    popularity: integer().notNull().default(0),
    playCount: integer().notNull().default(0),
    favoriteCount: integer().notNull().default(0),
    repostCount: integer().notNull().default(0),
    isExplicit: boolean().notNull().default(false),
    isAvailable: boolean().notNull().default(true),
    primaryColor: text(),
    secondaryColor: text(),
    source: text({ enum: CATALOG_SOURCES }),
    externalIsrc: text(),
    externalMusicbrainzReleaseId: text(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', title || ' ' || artist_name)`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('albums_type_check', sql`${t.type} in (${sql.raw(inList(ALBUM_TYPES))})`),
    check(
      'albums_source_check',
      sql`${t.source} is null or ${t.source} in (${sql.raw(inList(CATALOG_SOURCES))})`
    ),
    check('albums_popularity_check', sql`${t.popularity} between 0 and 100`),
    unique('albums_upc_key').on(t.upc),
    unique('albums_external_musicbrainz_release_id_key').on(t.externalMusicbrainzReleaseId),
    index('albums_artist_id_release_date_idx').on(t.artistId, t.releaseDate.desc()),
    index('albums_popularity_idx').on(t.popularity.desc()),
    index('albums_release_date_idx').on(t.releaseDate.desc()),
    index('albums_external_isrc_idx').on(t.externalIsrc),
    index('albums_search_gin').using('gin', t.searchVector),
  ]
);

// ── tracks ────────────────────────────────────────────────────────────────

export const tracks = pgTable(
  'tracks',
  {
    id: generatedId(),
    title: text().notNull(),
    artistId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'restrict' }),
    artistName: text().notNull(),
    albumId: text().references(() => albums.id, { onDelete: 'set null' }),
    albumName: text(),
    /** Seconds, fractional. */
    duration: doublePrecision().notNull(),
    trackNumber: integer(),
    discNumber: integer(),
    // ── Edition facts captured from the file's tags (text; create no entity) ──
    totalTracks: integer(),
    totalDiscs: integer(),
    /** TDOR — routinely a bare year; a string for the same reason `Album.releaseDate` is. */
    originalReleaseDate: text(),
    catalogNumber: text(),
    /** The LABEL that issued the recording — distinct from `metadata.publisher`. */
    label: text(),
    media: text(),
    releaseCountry: text(),
    replayGainTrackDb: doublePrecision(),
    replayGainAlbumDb: doublePrecision(),
    replayGainTrackPeak: doublePrecision(),
    comment: text(),
    /** `AudioSource` — absent while a track is still processing. */
    audioSourceUrl: text(),
    audioSourceFormat: text({ enum: AUDIO_FORMATS }),
    audioSourceBitrate: integer(),
    audioSourceDuration: doublePrecision(),
    coverArtId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesSmallId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesMediumId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesLargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesXxlargeId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    coverArtSizesOriginalId: text().references(() => imageAssets.id, { onDelete: 'set null' }),
    // ── Creator-editable descriptive metadata (`TrackMetadataSchema`, optional as a whole) ──
    metadataBpm: doublePrecision(),
    metadataKey: text(),
    metadataExplicit: boolean(),
    metadataLanguage: text(),
    metadataCopyright: text(),
    metadataPublisher: text(),
    metadataGenre: text().array(),
    /**
     * Provider-supplied, singular — distinct from `metadata.genre[]` above.
     * Enumerated for genre-card browsing (`browse.controller.ts`'s
     * `distinct('genre', …)`), the same way `Album.genre` is — but the
     * genres-table treatment the brief carries is scoped to `Album.genre`
     * (and, later, `Podcast.categories`) only, so this stays plain `text`
     * rather than a `genre_id` FK. Flagged in the report as worth a follow-up
     * decision, not resolved unilaterally here.
     */
    genre: text(),
    /** Queried by element in production (`radioPools.ts:204`, `mood: { $in: seed.moods }`) — see the index decision below. */
    mood: text(),
    /** Mongoose gives every track an implicit `[]` default; matched here. */
    tags: text().array().notNull().default(sql`array[]::text[]`),
    /** A real Date in Mongo (unlike `Album.releaseDate`, which is a string). */
    releaseDate: timestamptz(),
    /** Queried in production (`radioPools.ts:111`, `isExplicit: { $ne: true }`) — see the index decision below. */
    isExplicit: boolean().notNull().default(false),
    popularity: integer().notNull().default(0),
    playCount: integer().notNull().default(0),
    favoriteCount: integer().notNull().default(0),
    repostCount: integer().notNull().default(0),
    primaryColor: text(),
    secondaryColor: text(),
    /**
     * `isAvailable` + `copyrightRemoved` together ARE `playableTrackFilter()`
     * (`utils/catalogVisibility.ts:28-33`) — the predicate every catalog read
     * of `tracks` composes first: `playableContainers.ts`, `browse.controller.ts`,
     * and `radio/radioPools.ts`'s `findPoolTracks` (which puts it FIRST in
     * `constraints`, before its own `mood`/`isExplicit`/`genre` filters) all
     * confirmed by grep. Mongo indexed each singly; neither gets a standalone
     * Postgres index here, and that is a decision, not an omission — see the
     * index list below.
     */
    isAvailable: boolean().notNull().default(true),
    copyrightRemoved: boolean().notNull().default(false),
    removedAt: timestamptz(),
    removedReason: text(),
    /** An Oxy account id — no foreign key. Not `*_id`-suffixed. */
    removedBy: text(),
    /**
     * FK to `copyright_reports`, which has not landed yet (a moderation-
     * vertical table, out of this task's scope) — see `deferredForeignKeys.ts`.
     */
    copyrightReportId: text(),
    source: text({ enum: CATALOG_SOURCES }).notNull(),
    status: text({ enum: TRACK_STATUSES }).notNull().default('ready'),
    externalIsrc: text(),
    /**
     * Provider-supplied alternative images — server-only.
     * `stripExternalCatalogFields` deletes this from every response; see
     * `PROTECTED_COLUMNS_BY_TABLE`.
     */
    images: jsonb().$type<TrackImage[]>().notNull().default([]),
    hls: jsonb().$type<HlsRendition[]>().notNull().default([]),
    loudnessLufs: doublePrecision(),
    hlsMasterKey: text(),
    // The provenance LOG is `track_sources` (child table, below) — the third
    // sibling of `album_sources` and `catalog_entity_sources`. See the
    // file-level doc comment for why this wasn't in the first pass.
    /**
     * Content hash of the ingested audio — server-only (Mongoose `select:
     * false`). See `PROTECTED_COLUMNS_BY_TABLE`. Deliberately NOT unique —
     * two catalog tracks sharing bytes is a data error worth seeing, not a
     * write to reject.
     */
    sha256: text(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('english', title || ' ' || artist_name)`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('tracks_source_check', sql`${t.source} in (${sql.raw(inList(CATALOG_SOURCES))})`),
    check('tracks_status_check', sql`${t.status} in (${sql.raw(inList(TRACK_STATUSES))})`),
    check(
      'tracks_audio_source_format_check',
      sql`${t.audioSourceFormat} is null or ${t.audioSourceFormat} in (${sql.raw(inList(AUDIO_FORMATS))})`
    ),
    check('tracks_popularity_check', sql`${t.popularity} between 0 and 100`),
    unique('tracks_external_isrc_key').on(t.externalIsrc),
    /**
     * The index decision for `mood` / `isExplicit` / `isAvailable` /
     * `copyrightRemoved`, all four of which carried `index: true` in Mongo
     * and none of which gets a like-for-like Postgres index:
     *
     * `isAvailable` and `copyrightRemoved` are near-constant (almost every
     * track is available and not copyright-removed), so a standalone index on
     * either has poor selectivity on its own — Postgres would rarely choose
     * it over a sequential scan. What they ARE is the WHERE clause every real
     * query below actually runs under, because `playableTrackFilter()` gates
     * every one of them first. Folding the predicate into these five indexes
     * (rather than adding two near-useless singleton booleans) is "add the
     * index Mongo needed and lacked": each becomes an index-only scan over
     * PLAYABLE rows for exactly the sort/filter order it already serves.
     *
     * `mood` and `genre` get the same partial treatment for the identical
     * reason — `radioPools.ts`'s `findPoolTracks` composes `{ mood: { $in } }`
     * /`{ genre: … }` with `playableTrackFilter()` in the same query, never
     * standalone.
     *
     * `isExplicit` does NOT get its own index. Its one production filter
     * (`radioPools.ts:111`, `{ isExplicit: { $ne: true } }`) always runs
     * inside `findPoolTracks`, which already applies `playableTrackFilter()`
     * first — so by the time `isExplicit` is evaluated, the partial indexes
     * above have already cut the candidate set down to playable rows, and a
     * boolean filter over that already-small set costs nothing extra to scan.
     * A dedicated `is_explicit` index would only pay for itself if something
     * queried explicitness WITHOUT playability first, and nothing does.
     */
    index('tracks_artist_id_album_id_idx')
      .on(t.artistId, t.albumId)
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_popularity_idx')
      .on(t.popularity.desc())
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_play_count_idx')
      .on(t.playCount.desc())
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_created_at_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_genre_idx')
      .on(t.genre)
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_mood_idx')
      .on(t.mood)
      .where(sql`${t.isAvailable} = true and ${t.copyrightRemoved} = false`),
    index('tracks_sha256_idx').on(t.sha256),
    index('tracks_tags_gin').using('gin', t.tags),
    index('tracks_search_gin').using('gin', t.searchVector),
  ]
);

// ── track_credits (child of tracks — see the file-level doc comment) ───────

export const trackCredits = pgTable(
  'track_credits',
  {
    id: generatedId(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** Preserves Mongo array order. */
    position: integer().notNull(),
    name: text().notNull(),
    role: text().notNull(),
    /** `normalizeNameKey(name)` — indexed so "everything this person is credited on" is a lookup. */
    nameKey: text().notNull(),
    // No `catalog_entity_id` column — dead everywhere it was declared; see
    // the file-level doc comment.
  },
  (t) => [
    check('track_credits_position_check', sql`${t.position} >= 0`),
    unique('track_credits_track_id_position_key').on(t.trackId, t.position),
    index('track_credits_name_key_idx').on(t.nameKey),
  ]
);

// ── catalog_entity_strikes (child of catalog_entities) ──────────────────────

export const catalogEntityStrikes = pgTable(
  'catalog_entity_strikes',
  {
    id: generatedId(),
    catalogEntityId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
    reason: text().notNull(),
    /** Mirrors the Mongo subdocument's own `createdAt: { default: Date.now }`. */
    createdAt: createdAt(),
    /**
     * Optional per-strike audit pointer to the offending track. SET NULL, not
     * CASCADE: losing the track must not erase the moderation history.
     */
    trackId: text().references(() => tracks.id, { onDelete: 'set null' }),
  },
  (t) => [index('catalog_entity_strikes_catalog_entity_id_idx').on(t.catalogEntityId, t.createdAt.desc())]
);

// ── album_genres (junction, Album ↔ genres) ─────────────────────────────────

export const albumGenres = pgTable(
  'album_genres',
  {
    id: generatedId(),
    albumId: text()
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    genreId: text()
      .notNull()
      .references(() => genres.id, { onDelete: 'restrict' }),
  },
  (t) => [
    unique('album_genres_album_id_genre_id_key').on(t.albumId, t.genreId),
    index('album_genres_genre_id_idx').on(t.genreId),
  ]
);

// ── track_sources / album_sources / catalog_entity_sources (SourceProvenance child tables) ──

export const trackSources = pgTable(
  'track_sources',
  {
    id: generatedId(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    provider: text({ enum: PROVENANCE_PROVIDERS }).notNull(),
    externalId: text().notNull(),
    importedAt: timestamptz().notNull(),
    fields: text().array().notNull().default(sql`array[]::text[]`),
  },
  (t) => [
    check('track_sources_provider_check', sql`${t.provider} in (${sql.raw(inList(PROVENANCE_PROVIDERS))})`),
    check('track_sources_position_check', sql`${t.position} >= 0`),
    unique('track_sources_track_id_position_key').on(t.trackId, t.position),
  ]
);

export const albumSources = pgTable(
  'album_sources',
  {
    id: generatedId(),
    albumId: text()
      .notNull()
      .references(() => albums.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    provider: text({ enum: PROVENANCE_PROVIDERS }).notNull(),
    externalId: text().notNull(),
    /**
     * `new Date().toISOString()` at every call site (`resolveAlbum.ts:299`,
     * `enrichCatalogEntity.ts:89`) — a real instant, unlike the "possibly
     * partial" date-ish strings elsewhere in this schema (`releaseDate`,
     * `activeFrom`, …), so this is `timestamptz`, not `text`.
     */
    importedAt: timestamptz().notNull(),
    fields: text().array().notNull().default(sql`array[]::text[]`),
  },
  (t) => [
    check('album_sources_provider_check', sql`${t.provider} in (${sql.raw(inList(PROVENANCE_PROVIDERS))})`),
    check('album_sources_position_check', sql`${t.position} >= 0`),
    unique('album_sources_album_id_position_key').on(t.albumId, t.position),
  ]
);

export const catalogEntitySources = pgTable(
  'catalog_entity_sources',
  {
    id: generatedId(),
    catalogEntityId: text()
      .notNull()
      .references(() => catalogEntities.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    provider: text({ enum: PROVENANCE_PROVIDERS }).notNull(),
    externalId: text().notNull(),
    importedAt: timestamptz().notNull(),
    fields: text().array().notNull().default(sql`array[]::text[]`),
  },
  (t) => [
    check(
      'catalog_entity_sources_provider_check',
      sql`${t.provider} in (${sql.raw(inList(PROVENANCE_PROVIDERS))})`
    ),
    check('catalog_entity_sources_position_check', sql`${t.position} >= 0`),
    unique('catalog_entity_sources_catalog_entity_id_position_key').on(t.catalogEntityId, t.position),
  ]
);

// ── track_keys ────────────────────────────────────────────────────────────

export const trackKeys = pgTable(
  'track_keys',
  {
    id: generatedId(),
    /** Discriminates the id space `trackId` names — see `TRACK_KEY_KINDS`'s doc comment. */
    kind: text({ enum: TRACK_KEY_KINDS }).notNull(),
    trackId: text().notNull(),
    keyHex: text().notNull(),
    keyUri: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('track_keys_kind_check', sql`${t.kind} in (${sql.raw(inList(TRACK_KEY_KINDS))})`),
    // The three id spaces never collide (`hlsStorage.ts`'s own comment), so a
    // single unique constraint on the id alone matches Mongo's behaviour.
    unique('track_keys_track_id_key').on(t.trackId),
  ]
);

// ── isrc_registry (read-only importer mirror) ───────────────────────────────

export const isrcRegistry = pgTable(
  'isrc_registry',
  {
    id: generatedId(),
    isrc: text().notNull(),
    recordingMbid: text().notNull(),
    title: text().notNull(),
    artistCredit: text().notNull(),
    artistCreditNameKey: text().notNull(),
    lengthMs: integer(),
    releaseCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('isrc_registry_isrc_key').on(t.isrc),
    index('isrc_registry_recording_mbid_idx').on(t.recordingMbid),
    index('isrc_registry_artist_credit_name_key_idx').on(t.artistCreditNameKey),
  ]
);

// ── track_fingerprints ───────────────────────────────────────────────────

export const trackFingerprints = pgTable(
  'track_fingerprints',
  {
    id: generatedId(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    /** Chromaprint (`fpcalc`) raw fingerprint. */
    fingerprint: integer().array().notNull(),
    fingerprintDurationSec: doublePrecision().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('track_fingerprints_track_id_key').on(t.trackId),
    // The candidate bucket every match range-scans first (`duration ±3s`).
    index('track_fingerprints_duration_idx').on(t.fingerprintDurationSec),
  ]
);

// ── lyrics / lyrics_lines ─────────────────────────────────────────────────

export const lyrics = pgTable(
  'lyrics',
  {
    id: generatedId(),
    trackId: text()
      .notNull()
      .references(() => tracks.id, { onDelete: 'cascade' }),
    synced: boolean().notNull().default(false),
    plain: text(),
    source: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('lyrics_track_id_key').on(t.trackId)]
);

export const lyricsLines = pgTable(
  'lyrics_lines',
  {
    id: generatedId(),
    lyricsId: text()
      .notNull()
      .references(() => lyrics.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    timeMs: integer().notNull(),
    text: text().notNull(),
  },
  (t) => [
    check('lyrics_lines_position_check', sql`${t.position} >= 0`),
    unique('lyrics_lines_lyrics_id_position_key').on(t.lyricsId, t.position),
  ]
);

// ── musicbrainz_artists / musicbrainz_artist_urls (read-only importer mirror) ──

export const musicbrainzArtists = pgTable(
  'musicbrainz_artists',
  {
    id: generatedId(),
    mbid: text().notNull(),
    name: text().notNull(),
    sortName: text().notNull(),
    /** `name` through `normalizeNameKey` — the join key when no MBID is present. */
    nameKey: text().notNull(),
    disambiguation: text(),
    artistType: text({ enum: ARTIST_TYPES }),
    areaName: text(),
    countryCode: text(),
    /** ISO-8601, possibly partial (a bare year is normal). */
    beginDate: text(),
    endDate: text(),
    ended: boolean().notNull().default(false),
    aliases: text().array().notNull().default(sql`array[]::text[]`),
    isni: text(),
    ipi: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('musicbrainz_artists_mbid_key').on(t.mbid),
    check(
      'musicbrainz_artists_artist_type_check',
      sql`${t.artistType} is null or ${t.artistType} in (${sql.raw(inList(ARTIST_TYPES))})`
    ),
    index('musicbrainz_artists_name_key_idx').on(t.nameKey),
  ]
);

export const musicbrainzArtistUrls = pgTable(
  'musicbrainz_artist_urls',
  {
    id: generatedId(),
    musicbrainzArtistId: text()
      .notNull()
      .references(() => musicbrainzArtists.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /** Relationship type as MusicBrainz names it — `official homepage`, `discogs`, `wikidata`, … */
    type: text().notNull(),
    url: text().notNull(),
  },
  (t) => [
    check('musicbrainz_artist_urls_position_check', sql`${t.position} >= 0`),
    unique('musicbrainz_artist_urls_musicbrainz_artist_id_position_key').on(
      t.musicbrainzArtistId,
      t.position
    ),
  ]
);

// ── discogs_releases (read-only importer mirror) ────────────────────────────

export const discogsReleases = pgTable(
  'discogs_releases',
  {
    id: generatedId(),
    /** This row's OWN external identity — not a reference to a Syra row. */
    discogsReleaseId: text().notNull(),
    /** The join key: matching accepts ANY of a release's barcodes. */
    barcodes: text().array().notNull().default(sql`array[]::text[]`),
    title: text().notNull(),
    artistNames: text().array().notNull().default(sql`array[]::text[]`),
    labels: text().array().notNull().default(sql`array[]::text[]`),
    catalogNumbers: text().array().notNull().default(sql`array[]::text[]`),
    formats: text().array().notNull().default(sql`array[]::text[]`),
    countryCode: text(),
    released: text(),
    /**
     * Mirrors `DiscogsCreditSchema`. Stays jsonb: unlike `Track.credits[]`,
     * there is no reader anywhere for `DiscogsRelease.credits` outside its
     * own model file (`RELATIONS.md`; this whole collection is importer-
     * written and application-read nowhere yet), so there is no query-by-
     * element evidence to justify a child table. `catalogEntityId` inside
     * each entry is dead (never written, including by the importer script)
     * but there is no column here to omit — see the file-level doc comment.
     */
    credits: jsonb().$type<TrackCredit[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('discogs_releases_discogs_release_id_key').on(t.discogsReleaseId),
    index('discogs_releases_barcodes_gin').using('gin', t.barcodes),
  ]
);
