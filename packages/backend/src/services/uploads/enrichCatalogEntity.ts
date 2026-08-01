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

import type { CatalogImageSizes, ImageLicence, SourceProvenance } from '@syra/shared-types';
import { normalizeNameKey } from '@syra/shared-types';
import type { IArtist } from '../../models/CatalogEntity';
import { ArtistModel } from '../../models/CatalogEntity';
import { AlbumModel } from '../../models/Album';
import type { IMusicBrainzArtist } from '../../models/MusicBrainzArtist';
import { MusicBrainzArtistModel } from '../../models/MusicBrainzArtist';
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

export interface AlbumCoverResult {
  status: EnrichmentStatus;
  /** The stored image id, when one was recovered. */
  coverArt?: string;
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

function provenanceEntry(
  provider: SourceProvenance['provider'],
  externalId: string,
  fields: string[],
): SourceProvenance {
  return { provider, externalId, importedAt: new Date().toISOString(), fields };
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
  artist: IArtist,
  facts: WikidataArtistFacts,
  musicBrainz: IMusicBrainzArtist | null,
): { set: Record<string, unknown>; fields: string[] } {
  const set: Record<string, unknown> = {};
  const fields: string[] = [];

  const fillText = (field: string, current: unknown, incoming: string | undefined): void => {
    const existing = typeof current === 'string' ? current.trim() : '';
    if (existing.length > 0) return;
    if (incoming === undefined || incoming.trim().length === 0) return;
    set[field] = incoming.trim();
    fields.push(field);
  };

  const fillList = (field: string, current: unknown, incoming: ReadonlyArray<string>): void => {
    if (Array.isArray(current) && current.length > 0) return;
    const values = [...new Set(incoming.map((value) => value.trim()).filter(Boolean))];
    if (values.length === 0) return;
    set[field] = values;
    fields.push(field);
  };

  // MusicBrainz is preferred over Wikidata wherever both speak, because it is
  // the identity the MBID names — Wikidata's copy of the same fact is a mirror
  // of it. Wikidata is the only source for the description and the photo.
  fillText('bio', artist.bio, facts.description);
  fillText('country', artist.country, musicBrainz?.countryCode ?? facts.country?.name);
  fillText('sortName', artist.sortName, musicBrainz?.sortName);
  fillText('disambiguation', artist.disambiguation, musicBrainz?.disambiguation);
  fillText('artistType', artist.artistType, musicBrainz?.artistType);
  fillText('activeFrom', artist.activeFrom, musicBrainz?.beginDate ?? facts.activeFrom);
  fillText('activeUntil', artist.activeUntil, musicBrainz?.endDate ?? facts.activeUntil);

  fillList('aliases', artist.aliases, [...(musicBrainz?.aliases ?? []), ...facts.aliases]);
  fillList(
    'labels',
    artist.labels,
    facts.labels.map((label) => label.name).filter((name): name is string => name !== undefined),
  );

  // Members carry a `nameKey` so "everything this person played on" is a query
  // rather than a scan, and NO `catalogEntityId`: linking a member to a catalog
  // entity is a high-confidence identity claim, and a name from Wikidata's
  // `has part` is not one.
  const members = facts.members
    .map((member) => member.name)
    .filter((name): name is string => name !== undefined)
    .map((name) => ({ name, nameKey: normalizeNameKey(name) }));
  if (!(Array.isArray(artist.members) && artist.members.length > 0) && members.length > 0) {
    set.members = members;
    fields.push('members');
  }

  fillText('links.website', artist.links?.website, urlFor(musicBrainz, 'official homepage') ?? facts.officialWebsite);
  fillText('links.instagram', artist.links?.instagram, facts.instagram);
  fillText('links.x', artist.links?.x, facts.x);
  fillText('links.youtube', artist.links?.youtube, facts.youtube);
  // Guarded on the item id: when only the MusicBrainz slice answered, `itemId`
  // is empty and an unguarded template yields `…/wiki/`, a link to nothing that
  // renders on the profile as though it went somewhere.
  fillText(
    'links.wikidata',
    artist.links?.wikidata,
    facts.itemId ? `https://www.wikidata.org/wiki/${facts.itemId}` : undefined,
  );
  fillText('links.discogs', artist.links?.discogs, discogsUrl(facts.discogsArtistId));
  fillText('links.bandcamp', artist.links?.bandcamp, facts.bandcamp);
  fillText('links.soundcloud', artist.links?.soundcloud, facts.soundcloud);

  fillText(
    'externalIds.wikidataId',
    artist.externalIds?.wikidataId,
    facts.itemId ? facts.itemId : undefined,
  );
  fillText('externalIds.isni', artist.externalIds?.isni, musicBrainz?.isni ?? facts.isni);
  fillText('externalIds.ipi', artist.externalIds?.ipi, musicBrainz?.ipi ?? facts.ipi);
  fillText(
    'externalIds.discogsArtistId',
    artist.externalIds?.discogsArtistId,
    facts.discogsArtistId,
  );

  return { set, fields };
}

/** A URL relationship of the given type from the MusicBrainz slice. */
function urlFor(musicBrainz: IMusicBrainzArtist | null, type: string): string | undefined {
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
  artist: IArtist,
  imageUrl: string,
  licence: ImageLicence,
): Promise<{ set: Record<string, unknown>; fields: string[] } | undefined> {
  const mirrored = await mirrorCatalogImage([{ url: imageUrl }], {
    provider: MIRROR_PROVIDER,
    entityType: 'artist',
    externalId: artist._id.toString(),
  });
  if (!mirrored) return undefined;

  return {
    set: {
      image: mirrored.imageId,
      imageSizes: mirrored.imageSizes,
      // Stored BESIDE the image, because that is what the licence actually
      // requires — attribution held in a table nobody renders discharges nothing.
      imageLicence: licence,
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
  const artist = await ArtistModel.findById(artistId);
  if (!artist) {
    return { status: 'skipped', fieldsWritten: [], imageWritten: false, reason: 'artist not found' };
  }

  const mbid = artist.externalIds?.musicbrainzArtistId;
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
    MusicBrainzArtistModel.findOne({ mbid }).lean(),
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
  if (!artist.image && wikidataFacts.imageFileName) {
    const commons = await fetchCommonsImage(wikidataFacts.imageFileName);
    if (commons) {
      const stored = await storeArtistPhoto(artist, commons.url, commons.licence);
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

  await ArtistModel.updateOne({ _id: artist._id }, { $set: set });

  /**
   * Verify the write landed before claiming it did.
   *
   * Mongoose strict mode DISCARDS a `$set` on a path the schema does not
   * declare — silently, with no throw and no warning. Because `IArtist` derives
   * from the zod `Artist` type, a field present there and absent from the
   * Mongoose schema typechecks perfectly and writes nothing, so tsc cannot see
   * this and neither can a test that only inspects the return value.
   *
   * Left unchecked it is worse than lost data: the gaps-only rule would find the
   * same gaps on every pass, so a background job scheduled over the catalogue
   * would append a provenance entry per run forever while persisting nothing.
   * This is the smoke alarm for that — it names the dropped paths and refuses to
   * record provenance for a field that is not there.
   */
  const persisted = await ArtistModel.findById(artist._id).lean();
  const landed = fields.filter((field) => readPath(persisted, field) !== undefined);
  const dropped = fields.filter((field) => !landed.includes(field));

  if (dropped.length > 0) {
    logger.error('[enrichment] fields did not persist — Mongoose schema is missing these paths', {
      artistId,
      dropped,
    });
  }

  if (landed.length === 0) {
    return {
      status: 'skipped',
      fieldsWritten: [],
      imageWritten,
      reason: `nothing persisted; the artist schema declares none of: ${dropped.join(', ')}`,
    };
  }

  await ArtistModel.updateOne(
    { _id: artist._id },
    {
      $push: {
        sources: provenanceEntry(
          facts ? 'wikidata' : 'musicbrainz',
          facts ? facts.itemId : mbid,
          landed,
        ),
      },
    },
  );

  logger.info('[enrichment] artist profile enriched', {
    artistId,
    wikidataItem: facts?.itemId,
    musicbrainzArtistId: mbid,
    fields: landed,
  });

  return { status: 'enriched', fieldsWritten: landed, imageWritten };
}

/** Read a dotted path (`links.website`) off a lean document. */
function readPath(document: unknown, dottedPath: string): unknown {
  let current: unknown = document;
  for (const segment of dottedPath.split('.')) {
    const record = current as Record<string, unknown> | null | undefined;
    if (typeof record !== 'object' || record === null) return undefined;
    current = record[segment];
  }
  return current;
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

  const artist = await ArtistModel.findById(input.artistId).select('_id claimedByOxyUserId');
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

      await ArtistModel.updateOne(
        { _id: artist._id },
        {
          $push: {
            imageSuggestions: {
              image: {
                origin: 'upload',
                url: asset.id,
                ...(probed.width !== undefined && { width: probed.width }),
                ...(probed.height !== undefined && { height: probed.height }),
              },
              proposedAt: new Date().toISOString(),
              ...(input.proposedByOxyUserId && { proposedByOxyUserId: input.proposedByOxyUserId }),
              ...(input.sourceUploadId && { sourceUploadId: input.sourceUploadId }),
            },
          },
        },
      );
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
 * Fill in an EXISTING album's missing cover art.
 *
 * Separate from {@link recoverCoverArt} because the two run at different times:
 * that one unblocks creation, this one repairs an album already in the catalogue
 * — typically after a release id arrives from a later upload of the same record.
 */
export async function enrichAlbumCoverArt(albumId: string): Promise<AlbumCoverResult> {
  const album = await AlbumModel.findById(albumId);
  if (!album) return { status: 'skipped', reason: 'album not found' };
  if (album.coverArt) return { status: 'skipped', reason: 'album already has cover art' };

  const releaseMbid = album.externalIds?.musicbrainzReleaseId;
  if (!releaseMbid) {
    return { status: 'skipped', reason: 'no MusicBrainz release id to look the artwork up by' };
  }

  const recovered = await recoverCoverArt({ releaseMbid, externalId: albumId });
  if (!recovered) {
    return { status: 'nothing-found', reason: `Cover Art Archive has no front cover for ${releaseMbid}` };
  }

  await AlbumModel.updateOne(
    { _id: album._id },
    {
      $set: {
        coverArt: recovered.coverArt,
        coverArtSizes: recovered.imageSizes,
        ...(recovered.primaryColor !== undefined && { primaryColor: recovered.primaryColor }),
        ...(recovered.secondaryColor !== undefined && { secondaryColor: recovered.secondaryColor }),
      },
      $push: { sources: provenanceEntry('cover-art-archive', releaseMbid, ['coverArt']) },
    },
  );

  logger.info('[enrichment] album cover art recovered', { albumId, releaseMbid });
  return { status: 'enriched', coverArt: recovered.coverArt };
}
