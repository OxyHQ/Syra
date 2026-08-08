/**
 * Filling in an artist profile that was created from the tags of an MP3.
 *
 * A contributed profile is born with a name and nothing else. This is what turns
 * it into something worth looking at — a photograph, a one-line description, a
 * country, the official site — from sources that are free, keyless, and licensed
 * for reuse: Wikidata (CC0) and, through it, Wikimedia Commons.
 *
 * FOUR RULES, and each one exists because breaking it is worse than an empty
 * profile:
 *
 * 1. **HIGH CONFIDENCE ONLY.** Enrichment starts from
 *    `externalIds.musicbrainzArtistId` and there is no name-based path — not a
 *    discouraged one, none. A name lookup for "Nirvana", "Eclipse" or "Prince"
 *    returns a real, confident, wrong answer, and a profile carrying a stranger's
 *    face is worse than a blank one because it looks finished. An artist with no
 *    MBID is skipped, and that is the correct outcome, not a gap to work around.
 * 2. **GAPS ONLY.** Nothing already set is ever overwritten. A claiming artist's
 *    own bio outranks Wikidata's permanently.
 * 3. **EVERY IMPORTED FIELD IS RECORDED** in `sources[]` with provider and date,
 *    so the artist who claims the profile can see exactly what came from outside
 *    and replace all of it.
 * 4. **NO IMAGE WITHOUT ITS LICENCE.** Commons files are individually licensed
 *    and attribution is a condition of use, not a nicety. `fetchCommonsImage`
 *    returns nothing when it cannot capture both, so there is no branch here that
 *    could store one anyway.
 *
 * It runs in the BACKGROUND, never inline in an upload: these APIs are rate
 * limited to about one request a second and a listener must not wait behind
 * that. `enrichArtistProfile` is the job body; the queue wiring lives with the
 * rest of the BullMQ setup in `services/ingest`.
 */

import { and, asc, count, eq, sql } from 'drizzle-orm';
import type { ArtistMember, CatalogImageSizes, ImageLicence, SourceProvenance } from '@syra/shared-types';
import { normalizeNameKey } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../../db/postgres';
import {
  albums,
  albumSources,
  catalogEntities,
  catalogEntitySources,
  musicbrainzArtists,
  musicbrainzArtistUrls,
} from '../../db/schema/catalog';
import sharp from 'sharp';
import { mirrorCatalogImage } from '../catalog/catalogImageAssets';
import { storeImageAsset } from '../imageAssetService';
import { logger } from '../../utils/logger';
import { fetchCoverArtForRelease, fetchCoverArtForReleaseGroup } from './coverArtArchive';
import type { ExtractedPicture } from './extractMetadata';
import { fetchCommonsImage } from './wikimediaCommons';
import { lookupArtistOnWikidata, type WikidataArtistFacts } from './wikidata';

// ── Results ─────────────────────────────────────────────────────────────────

export type EnrichmentStatus = 'enriched' | 'nothing-found' | 'skipped';

export interface ArtistEnrichmentResult {
  status: EnrichmentStatus;
  /** Which profile fields this run filled. Empty when everything was already set. */
  fieldsWritten: string[];
  /** True when a licensed photograph was stored. */
  imageWritten: boolean;
  /** Why nothing happened, when `status` is not `enriched`. */
  reason?: string;
}

/**
 * `ImageAsset.catalog.provider` has no `wikimedia-commons` / `cover-art-archive`
 * value, so the stored asset is tagged with the closest existing one.
 *
 * This is a secondary index on the asset, NOT the audit record: the authoritative
 * provider travels with the image in `Artist.imageLicence.sourceUrl` and in the
 * `sources[]` entry this module writes, both of which name the real source. The
 * enum is worth widening, but nothing legal or auditable depends on it.
 */
const MIRROR_PROVIDER = 'cc' as const;

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * Append a provenance entry to a child table.
 *
 * `$push` had no position to maintain; `catalog_entity_sources` and
 * `album_sources` are ordered by a `position` unique per parent, so the next
 * one is counted rather than assumed. Counting inside the caller's transaction
 * is what makes two concurrent enrichments of the same artist fail loudly on
 * the unique constraint instead of silently overwriting each other's entry.
 */
async function appendProvenance(
  db: DbOrTransaction,
  table: typeof catalogEntitySources | typeof albumSources,
  parentColumn: 'catalogEntityId' | 'albumId',
  parentId: string,
  provider: SourceProvenance['provider'],
  externalId: string,
  fields: string[],
): Promise<void> {
  const column = parentColumn === 'catalogEntityId'
    ? catalogEntitySources.catalogEntityId
    : albumSources.albumId;
  const [existing] = await db.select({ total: count() }).from(table).where(eq(column, parentId));

  await db.insert(table).values({
    [parentColumn]: parentId,
    position: existing?.total ?? 0,
    provider,
    externalId,
    importedAt: new Date(),
    fields,
  });
}

/**
 * The artist columns the gaps-only rule reads. Named, not the whole row:
 * `publicColumns()` protects two of them and a whole-row read would carry both
 * into a value this module passes around.
 */
const ENRICHABLE_COLUMNS = {
  id: catalogEntities.id,
  bio: catalogEntities.bio,
  country: catalogEntities.country,
  sortName: catalogEntities.sortName,
  disambiguation: catalogEntities.disambiguation,
  artistType: catalogEntities.artistType,
  activeFrom: catalogEntities.activeFrom,
  activeUntil: catalogEntities.activeUntil,
  aliases: catalogEntities.aliases,
  labels: catalogEntities.labels,
  members: catalogEntities.members,
  linksWebsite: catalogEntities.linksWebsite,
  linksInstagram: catalogEntities.linksInstagram,
  linksX: catalogEntities.linksX,
  linksYoutube: catalogEntities.linksYoutube,
  linksWikidata: catalogEntities.linksWikidata,
  linksDiscogs: catalogEntities.linksDiscogs,
  linksBandcamp: catalogEntities.linksBandcamp,
  linksSoundcloud: catalogEntities.linksSoundcloud,
  externalWikidataId: catalogEntities.externalWikidataId,
  externalIsni: catalogEntities.externalIsni,
  externalIpi: catalogEntities.externalIpi,
  externalDiscogsArtistId: catalogEntities.externalDiscogsArtistId,
  externalMusicbrainzArtistId: catalogEntities.externalMusicbrainzArtistId,
  imageId: catalogEntities.imageId,
} as const;

type EnrichableArtist = {
  [K in keyof typeof ENRICHABLE_COLUMNS]: (typeof catalogEntities.$inferSelect)[K];
};

/** The subset of `catalog_entities` columns an enrichment run may write. */
type ArtistPatch = Partial<
  Pick<
    typeof catalogEntities.$inferInsert,
    | 'bio' | 'country' | 'sortName' | 'disambiguation' | 'artistType'
    | 'activeFrom' | 'activeUntil' | 'aliases' | 'labels' | 'members'
    | 'linksWebsite' | 'linksInstagram' | 'linksX' | 'linksYoutube'
    | 'linksWikidata' | 'linksDiscogs' | 'linksBandcamp' | 'linksSoundcloud'
    | 'externalWikidataId' | 'externalIsni' | 'externalIpi' | 'externalDiscogsArtistId'
    | 'imageId' | 'imageSizesSmallId' | 'imageSizesMediumId' | 'imageSizesLargeId'
    | 'imageSizesXlargeId' | 'imageSizesXxlargeId' | 'imageSizesOriginalId'
    | 'imageLicenceLicence' | 'imageLicenceLicenceUrl' | 'imageLicenceAttribution'
    | 'imageLicenceSourceUrl' | 'primaryColor' | 'secondaryColor'
  >
>;

/** The MusicBrainz mirror row plus its URL relationships. */
interface MusicBrainzSlice {
  sortName: string;
  disambiguation: string | null;
  artistType: string | null;
  areaName: string | null;
  countryCode: string | null;
  beginDate: string | null;
  endDate: string | null;
  aliases: string[];
  isni: string | null;
  ipi: string | null;
  urls: { type: string; url: string }[];
}

// ── Artist ──────────────────────────────────────────────────────────────────

/**
 * Build the `$set` for the fields that are currently EMPTY.
 *
 * Written as a table of `[field, currentValue, incomingValue]` so the gaps-only
 * rule is one condition applied uniformly, rather than a condition repeated per
 * field with one place to forget it.
 */
function gapFilling(
  artist: EnrichableArtist,
  facts: WikidataArtistFacts,
  musicBrainz: MusicBrainzSlice | null,
): { set: ArtistPatch; fields: string[] } {
  const set: ArtistPatch = {};
  const fields: string[] = [];

  /**
   * `column` is the drizzle key the value is written to; `field` is the DOTTED
   * name reported in `fieldsWritten` and recorded in the provenance entry.
   *
   * They differ (`links.website` -> `linksWebsite`) and both matter: the column
   * is what lands, and the dotted name is what the API and the `sources[]`
   * audit trail have always called the field. Reporting the column name instead
   * would silently rewrite a provenance vocabulary that is already stored.
   */
  const fillText = (
    column: keyof ArtistPatch,
    field: string,
    current: string | null | undefined,
    incoming: string | null | undefined,
  ): void => {
    const existing = typeof current === 'string' ? current.trim() : '';
    if (existing.length > 0) return;
    if (incoming === undefined || incoming === null || incoming.trim().length === 0) return;
    Object.assign(set, { [column]: incoming.trim() });
    fields.push(field);
  };

  const fillList = (
    column: keyof ArtistPatch,
    field: string,
    current: readonly string[] | null | undefined,
    incoming: ReadonlyArray<string>,
  ): void => {
    if (Array.isArray(current) && current.length > 0) return;
    const values = [...new Set(incoming.map((value) => value.trim()).filter(Boolean))];
    if (values.length === 0) return;
    Object.assign(set, { [column]: values });
    fields.push(field);
  };

  // MusicBrainz is preferred over Wikidata wherever both speak, because it is
  // the identity the MBID names — Wikidata's copy of the same fact is a mirror
  // of it. Wikidata is the only source for the description and the photo.
  fillText('bio', 'bio', artist.bio, facts.description);
  fillText('country', 'country', artist.country, musicBrainz?.countryCode ?? facts.country?.name);
  fillText('sortName', 'sortName', artist.sortName, musicBrainz?.sortName);
  fillText('disambiguation', 'disambiguation', artist.disambiguation, musicBrainz?.disambiguation);
  fillText('artistType', 'artistType', artist.artistType, musicBrainz?.artistType);
  fillText('activeFrom', 'activeFrom', artist.activeFrom, musicBrainz?.beginDate ?? facts.activeFrom);
  fillText('activeUntil', 'activeUntil', artist.activeUntil, musicBrainz?.endDate ?? facts.activeUntil);

  fillList('aliases', 'aliases', artist.aliases, [...(musicBrainz?.aliases ?? []), ...facts.aliases]);
  fillList(
    'labels',
    'labels',
    artist.labels,
    facts.labels.map((label) => label.name).filter((name): name is string => name !== undefined),
  );

  // Members carry a `nameKey` so "everything this person played on" is a query
  // rather than a scan, and NO `catalogEntityId`: linking a member to a catalog
  // entity is a high-confidence identity claim, and a name from Wikidata's
  // `has part` is not one.
  const members: ArtistMember[] = facts.members
    .map((member) => member.name)
    .filter((name): name is string => name !== undefined)
    .map((name) => ({ name, nameKey: normalizeNameKey(name) }));
  if (!(Array.isArray(artist.members) && artist.members.length > 0) && members.length > 0) {
    set.members = members;
    fields.push('members');
  }

  fillText('linksWebsite', 'links.website', artist.linksWebsite, urlFor(musicBrainz, 'official homepage') ?? facts.officialWebsite);
  fillText('linksInstagram', 'links.instagram', artist.linksInstagram, facts.instagram);
  fillText('linksX', 'links.x', artist.linksX, facts.x);
  fillText('linksYoutube', 'links.youtube', artist.linksYoutube, facts.youtube);
  // Guarded on the item id: when only the MusicBrainz slice answered, `itemId`
  // is empty and an unguarded template yields `…/wiki/`, a link to nothing that
  // renders on the profile as though it went somewhere.
  fillText(
    'linksWikidata',
    'links.wikidata',
    artist.linksWikidata,
    facts.itemId ? `https://www.wikidata.org/wiki/${facts.itemId}` : undefined,
  );
  fillText('linksDiscogs', 'links.discogs', artist.linksDiscogs, discogsUrl(facts.discogsArtistId));
  fillText('linksBandcamp', 'links.bandcamp', artist.linksBandcamp, facts.bandcamp);
  fillText('linksSoundcloud', 'links.soundcloud', artist.linksSoundcloud, facts.soundcloud);

  fillText(
    'externalWikidataId',
    'externalIds.wikidataId',
    artist.externalWikidataId,
    facts.itemId ? facts.itemId : undefined,
  );
  fillText('externalIsni', 'externalIds.isni', artist.externalIsni, musicBrainz?.isni ?? facts.isni);
  fillText('externalIpi', 'externalIds.ipi', artist.externalIpi, musicBrainz?.ipi ?? facts.ipi);
  fillText(
    'externalDiscogsArtistId',
    'externalIds.discogsArtistId',
    artist.externalDiscogsArtistId,
    facts.discogsArtistId,
  );

  return { set, fields };
}

/** A URL relationship of the given type from the MusicBrainz slice. */
function urlFor(musicBrainz: MusicBrainzSlice | null, type: string): string | undefined {
  return musicBrainz?.urls.find((url) => url.type === type)?.url;
}

function discogsUrl(discogsArtistId: string | undefined): string | undefined {
  return discogsArtistId === undefined
    ? undefined
    : `https://www.discogs.com/artist/${discogsArtistId}`;
}

/**
 * Download, resize and store the Commons photograph.
 *
 * The bytes go through `mirrorCatalogImage`, the backend's single chokepoint for
 * fetching an external image: it does the DNS and IP-range validation that a
 * remote-supplied URL requires, caps the download, and produces the size
 * variants every surface renders. Nothing here fetches a URL itself.
 */
async function storeArtistPhoto(
  artistId: string,
  imageUrl: string,
  licence: ImageLicence,
): Promise<{ set: ArtistPatch; fields: string[] } | undefined> {
  const mirrored = await mirrorCatalogImage([{ url: imageUrl }], {
    provider: MIRROR_PROVIDER,
    entityType: 'artist',
    externalId: artistId,
  });
  if (!mirrored) return undefined;

  return {
    set: {
      imageId: mirrored.imageId,
      imageSizesSmallId: mirrored.imageSizes.small?.id ?? null,
      imageSizesMediumId: mirrored.imageSizes.medium?.id ?? null,
      imageSizesLargeId: mirrored.imageSizes.large?.id ?? null,
      imageSizesXlargeId: mirrored.imageSizes.xlarge?.id ?? null,
      imageSizesXxlargeId: mirrored.imageSizes.xxlarge?.id ?? null,
      imageSizesOriginalId: mirrored.imageSizes.original?.id ?? null,
      // Stored BESIDE the image, because that is what the licence actually
      // requires — attribution held in a table nobody renders discharges nothing.
      imageLicenceLicence: licence.licence,
      imageLicenceLicenceUrl: licence.licenceUrl ?? null,
      imageLicenceAttribution: licence.attribution,
      imageLicenceSourceUrl: licence.sourceUrl,
      ...(mirrored.primaryColor !== undefined && { primaryColor: mirrored.primaryColor }),
      ...(mirrored.secondaryColor !== undefined && { secondaryColor: mirrored.secondaryColor }),
    },
    fields: ['image', 'imageLicence'],
  };
}

/**
 * Enrich one artist profile from Wikidata and Commons.
 *
 * Idempotent: a second run finds every field already set and writes nothing, so
 * it is safe to re-queue after a failure or run over the whole catalogue.
 */
export async function enrichArtistProfile(artistId: string): Promise<ArtistEnrichmentResult> {
  const [artist] = await getDb()
    .select(ENRICHABLE_COLUMNS)
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
    .limit(1);

  if (!artist) {
    return { status: 'skipped', fieldsWritten: [], imageWritten: false, reason: 'artist not found' };
  }

  const mbid = artist.externalMusicbrainzArtistId;
  if (!mbid) {
    // The single most important branch in this file. An artist resolved by name
    // alone has no verified identity, and enriching one is how the wrong
    // person's photograph ends up on a real musician's page.
    return {
      status: 'skipped',
      fieldsWritten: [],
      imageWritten: false,
      reason: 'no MusicBrainz artist id — enrichment requires a verified identity',
    };
  }

  // Both sources are keyed by the SAME verified MBID. The local slice is a point
  // query against the CC0 dump; Wikidata is the live half. Either may be absent —
  // the dump may not have been imported yet, and not every artist has a Wikidata
  // item — so the run continues on whichever answered.
  const [facts, musicBrainz] = await Promise.all([
    lookupArtistOnWikidata(mbid),
    loadMusicBrainzSlice(mbid),
  ]);

  if (!facts && !musicBrainz) {
    return {
      status: 'nothing-found',
      fieldsWritten: [],
      imageWritten: false,
      reason: `neither Wikidata nor the MusicBrainz slice knows artist ${mbid}`,
    };
  }

  const wikidataFacts: WikidataArtistFacts = facts ?? {
    itemId: '',
    aliases: [],
    members: [],
    labels: [],
  };
  const { set, fields } = gapFilling(artist, wikidataFacts, musicBrainz);

  // The photograph is attempted only when the profile has none. The download is
  // the expensive part of this job, so the check comes before the fetch rather
  // than after it.
  let imageWritten = false;
  if (!artist.imageId && wikidataFacts.imageFileName) {
    const commons = await fetchCommonsImage(wikidataFacts.imageFileName);
    if (commons) {
      const stored = await storeArtistPhoto(artistId, commons.url, commons.licence);
      if (stored) {
        Object.assign(set, stored.set);
        fields.push(...stored.fields);
        imageWritten = true;
      }
    }
  }

  if (fields.length === 0) {
    return {
      status: 'nothing-found',
      fieldsWritten: [],
      imageWritten: false,
      reason: 'every field Wikidata could fill is already set',
    };
  }

  /**
   * The write and its provenance entry commit TOGETHER.
   *
   * The Mongo version issued them as two `updateOne`s with a verification read
   * between them, because Mongoose strict mode DISCARDS a `$set` on an
   * undeclared path — silently, with no throw — so "did the fields land" was a
   * real question that had to be asked at runtime, and a background job could
   * otherwise append a provenance entry per run forever while persisting
   * nothing.
   *
   * That question cannot be asked here because it cannot be false: an unknown
   * column key is a `tsc` error, and an unknown column in SQL is a runtime
   * error, so a write that returns is a write that landed. The verification
   * read, `readPath`, and the "nothing persisted" result arm are deleted rather
   * than translated — they were compensating for a database behaviour this one
   * does not have.
   */
  await getDb().transaction(async (tx) => {
    await tx.update(catalogEntities).set(set).where(eq(catalogEntities.id, artistId));
    await appendProvenance(
      tx,
      catalogEntitySources,
      'catalogEntityId',
      artistId,
      facts ? 'wikidata' : 'musicbrainz',
      facts ? facts.itemId : mbid,
      fields,
    );
  });

  logger.info('[enrichment] artist profile enriched', {
    artistId,
    wikidataItem: facts?.itemId,
    musicbrainzArtistId: mbid,
    fields,
  });

  return { status: 'enriched', fieldsWritten: fields, imageWritten };
}

/** The MusicBrainz mirror row for one MBID, with its URL relationships. */
async function loadMusicBrainzSlice(mbid: string): Promise<MusicBrainzSlice | null> {
  const [row] = await getDb()
    .select({
      id: musicbrainzArtists.id,
      sortName: musicbrainzArtists.sortName,
      disambiguation: musicbrainzArtists.disambiguation,
      artistType: musicbrainzArtists.artistType,
      areaName: musicbrainzArtists.areaName,
      countryCode: musicbrainzArtists.countryCode,
      beginDate: musicbrainzArtists.beginDate,
      endDate: musicbrainzArtists.endDate,
      aliases: musicbrainzArtists.aliases,
      isni: musicbrainzArtists.isni,
      ipi: musicbrainzArtists.ipi,
    })
    .from(musicbrainzArtists)
    .where(eq(musicbrainzArtists.mbid, mbid))
    .limit(1);

  if (!row) return null;

  // `urls` was an embedded array; `musicbrainz_artist_urls` preserves its order
  // by `position`, and `urlFor` takes the FIRST relationship of a type, so the
  // ordering is load-bearing rather than cosmetic.
  const urls = await getDb()
    .select({ type: musicbrainzArtistUrls.type, url: musicbrainzArtistUrls.url })
    .from(musicbrainzArtistUrls)
    .where(eq(musicbrainzArtistUrls.musicbrainzArtistId, row.id))
    .orderBy(asc(musicbrainzArtistUrls.position));

  return { ...row, urls };
}

// ── Artist photo suggestions from an uploaded file ──────────────────────────

/**
 * ID3v2 / FLAC picture types that depict the ARTIST rather than the release.
 *
 * `0x07` lead artist/soloist, `0x08` artist/performer, `0x0A` band/orchestra.
 * `music-metadata` renders these as the descriptive strings matched below.
 * M4A's `covr` atom has no type enum at all, so a picture out of an M4A is never
 * treated as an artist photo — there is no way to tell it from the cover.
 */
const ARTIST_PICTURE_TYPES = ['lead artist', 'artist', 'performer', 'band', 'orchestra'];

/** Front cover, back cover and disc-face pictures are the release, not the artist. */
const RELEASE_PICTURE_TYPES = ['cover', 'media', 'leaflet', 'illustration'];

/**
 * Is this embedded picture of the ARTIST rather than of the release?
 *
 * Exported because the upload controller needs the same answer when it picks the
 * cover art — a front cover and an artist photo are both `ExtractedPicture`s and
 * a second, drifting copy of this predicate would eventually publish one as the
 * other.
 */
export function isArtistPicture(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase();
  if (RELEASE_PICTURE_TYPES.some((release) => normalized.includes(release))) return false;
  return ARTIST_PICTURE_TYPES.some((artist) => normalized.includes(artist));
}

/**
 * The one external effect this function has, injectable for tests.
 *
 * A `mock.module` would be process-GLOBAL in bun and would silently replace the
 * image service for every other test file in the run — a hazard this codebase
 * has already been bitten by. A parameter is scoped to the call.
 */
export interface ArtistPhotoSuggestionDeps {
  storeImage: typeof storeImageAsset;
}

export interface ArtistPhotoSuggestionInput {
  artistId: string;
  /** Embedded pictures from the uploaded file, with the types the container declared. */
  pictures: ReadonlyArray<ExtractedPicture>;
  /** The uploader whose file carried the picture — the evidence trail. */
  proposedByOxyUserId?: string;
  sourceUploadId?: string;
}

/**
 * Store an artist-type embedded picture as a SUGGESTION, never as the profile photo.
 *
 * A picture inside a stranger's MP3 is a guess about what an artist looks like.
 * Publishing it would turn that guess into catalog content on every surface in
 * the product, attached to a real person's name — a categorically different act
 * from showing the cover of the disc the file came from. So it waits in the
 * claim flow for the artist to accept or discard.
 *
 * `origin: 'upload'`, so no third-party licence is required: the bytes arrived
 * with the same provenance as the audio the uploader attested to. That is the
 * one image path where absent attribution is correct rather than a gap.
 *
 * Returns how many suggestions were stored. Zero is the common case and is not a
 * failure — artist-type pictures appear in a low single-digit percentage of real
 * files. Wikidata/Commons and the claiming artist remain the real sources.
 */
export async function suggestArtistPhotosFromUpload(
  input: ArtistPhotoSuggestionInput,
  deps: ArtistPhotoSuggestionDeps = { storeImage: storeImageAsset },
): Promise<number> {
  const candidates = input.pictures.filter((picture) => isArtistPicture(picture.type));
  if (candidates.length === 0) return 0;

  const [artist] = await getDb()
    .select({ id: catalogEntities.id })
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, input.artistId), eq(catalogEntities.type, 'artist')))
    .limit(1);
  if (!artist) return 0;

  let stored = 0;
  for (const picture of candidates) {
    // `storeImageAsset`, NOT `mirrorCatalogImage`: the bytes are already in hand
    // from the file's own picture frame. The mirror fetches a remote URL and
    // would have to be handed a `data:` URI, which its SSRF validation rejects —
    // so it would have failed silently on every file and this whole path would
    // have been another mechanism that runs and does nothing.
    try {
      const probed = await sharp(picture.data).metadata();
      const asset = await deps.storeImage({
        buffer: picture.data,
        filename: `artist-suggestion.${probed.format ?? 'jpg'}`,
        contentType: picture.mimeType,
        ownerType: 'upload',
        ...(input.proposedByOxyUserId && { uploadedBy: input.proposedByOxyUserId }),
        ...(probed.width !== undefined && { width: probed.width }),
        ...(probed.height !== undefined && { height: probed.height }),
      });

      /**
       * `jsonb || jsonb` — the append `$push` did, expressed in SQL so the read
       * and the write are one statement. Reading the array, appending in JS and
       * writing it back would lose a suggestion whenever two uploads of the same
       * artist land at once, which is exactly the shape this path has: several
       * files of one release, screened in parallel.
       *
       * `coalesce` because the column is nullable and `null || anything` is null
       * in Postgres — without it the FIRST suggestion for an artist would be
       * silently discarded, and only the first.
       */
      const suggestion = {
        image: {
          origin: 'upload',
          url: asset.id,
          ...(probed.width !== undefined && { width: probed.width }),
          ...(probed.height !== undefined && { height: probed.height }),
        },
        proposedAt: new Date().toISOString(),
        ...(input.proposedByOxyUserId && { proposedByOxyUserId: input.proposedByOxyUserId }),
        ...(input.sourceUploadId && { sourceUploadId: input.sourceUploadId }),
      };

      await getDb()
        .update(catalogEntities)
        .set({
          imageSuggestions: sql`coalesce(${catalogEntities.imageSuggestions}, '[]'::jsonb) || ${JSON.stringify([suggestion])}::jsonb`,
        })
        .where(eq(catalogEntities.id, artist.id));
      stored += 1;
    } catch (err) {
      // A malformed picture frame must not fail the upload that carried it —
      // the audio is the thing the listener uploaded.
      logger.warn('[enrichment] could not store an artist photo suggestion', {
        artistId: input.artistId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (stored > 0) {
    logger.info('[enrichment] artist photo suggestions stored from an upload', {
      artistId: input.artistId,
      stored,
    });
  }
  return stored;
}

// ── Album cover art ─────────────────────────────────────────────────────────

export interface RecoveredCoverArt {
  /** The stored image id, ready to satisfy the required `Album.coverArt`. */
  coverArt: string;
  imageSizes: CatalogImageSizes;
  primaryColor?: string;
  secondaryColor?: string;
  licence: ImageLicence;
}

/**
 * Recover cover art for a release that has none embedded.
 *
 * Called BEFORE the album exists — `resolveAlbum` cannot create an `Album`
 * without `coverArt`, so this is what decides whether the container can exist at
 * all. Returns `undefined` when the archive has nothing, and the correct
 * response to that is loose tracks under the artist, never a placeholder image.
 *
 * `releaseGroupMbid` is a genuine second chance rather than a duplicate attempt:
 * a specific pressing frequently has no artwork while another edition of the
 * same album does, and the release-group endpoint finds that one.
 */
export async function recoverCoverArt(input: {
  releaseMbid?: string;
  releaseGroupMbid?: string;
  /** Used only to key the stored asset. */
  externalId: string;
}): Promise<RecoveredCoverArt | undefined> {
  const found =
    (input.releaseMbid ? await fetchCoverArtForRelease(input.releaseMbid) : undefined) ??
    (input.releaseGroupMbid ? await fetchCoverArtForReleaseGroup(input.releaseGroupMbid) : undefined);
  if (!found) return undefined;

  const mirrored = await mirrorCatalogImage([{ url: found.url }], {
    provider: MIRROR_PROVIDER,
    entityType: 'album',
    externalId: input.externalId,
  });
  if (!mirrored) return undefined;

  return {
    coverArt: mirrored.imageId,
    imageSizes: mirrored.imageSizes,
    ...(mirrored.primaryColor !== undefined && { primaryColor: mirrored.primaryColor }),
    ...(mirrored.secondaryColor !== undefined && { secondaryColor: mirrored.secondaryColor }),
    licence: found.licence,
  };
}

/**
 * `enrichAlbumCoverArt` is DELETED, not ported, and the reason is worth keeping.
 *
 * It repaired "an EXISTING album's missing cover art" — a state that cannot
 * exist. `albums.cover_art_id` is NOT NULL (and `models/Album.ts:69` declared
 * `coverArt: { type: String, required: true }` for the same reason: an album is
 * not created at all unless real artwork was found), so its second line —
 * `if (album.coverArt) return skipped` — was unconditionally true.
 *
 * It had no production caller either: the only references anywhere were its own
 * definition and its own tests, and those reached the working arm by `$unset`-ing
 * `coverArt` after creation, i.e. by constructing a document Mongoose would have
 * refused to save. Under a NOT NULL column that fixture is unrepresentable, so a
 * faithful port would have been a function that provably does nothing plus tests
 * that could no longer set it up.
 *
 * `recoverCoverArt` above is the live half of this pair and is untouched: it runs
 * BEFORE an album exists and is what decides whether the container can be created.
 */
