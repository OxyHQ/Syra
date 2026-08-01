/**
 * Cover Art Archive — the recovery path for an album with no embedded artwork.
 *
 * This one clears a real blocker rather than adding polish. `Album.coverArt` is
 * REQUIRED, so a contributed file whose tags carry no front cover cannot create
 * an album at all, and its tracks stay loose under the artist forever. CAA is
 * keyed by MusicBrainz release id — which Picard-tagged files carry as
 * `MUSICBRAINZ_ALBUMID` — so when the file names its release, the artwork is
 * recoverable.
 *
 * Preference order, per the plan: embedded front cover above the minimum size →
 * Cover Art Archive → no album. Never an invented placeholder.
 *
 * ── A LIMITATION TO BE HONEST ABOUT ────────────────────────────────────────
 * CAA's API returns NO per-image licence. Its response carries ids, types,
 * `front`/`back` flags, an approval flag and thumbnail URLs — nothing about
 * terms or authorship. Every other image source here yields a licence read from
 * the source itself; this one cannot, because the source does not publish one
 * per image.
 *
 * What is recorded instead is stated plainly rather than dressed up as a capture:
 * the archive-level terms, and a `sourceUrl` pointing at the MusicBrainz RELEASE
 * page, which is the page that documents where the artwork came from and which
 * release it belongs to. That is a weaker claim than the Commons path makes, and
 * it is a product/legal decision rather than an engineering one — flagged to the
 * team lead rather than decided here.
 */

import type { AttributableImage, ImageLicence } from '@syra/shared-types';
import { asArray, asRecord, asString, fetchEnrichmentJson } from './enrichmentHttp';

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which stored thumbnail to request, in order of preference.
 *
 * 1200 px is above what any catalogue surface renders and well under the
 * multi-megabyte originals some releases carry. CAA does not render on demand —
 * these are pre-generated sizes and a release may not have all of them, so the
 * list is walked rather than assumed.
 */
const THUMBNAIL_PREFERENCE = ['1200', 'large', '500', '250', 'small'] as const;

export interface CoverArtImage {
  /** Direct URL to the bytes — for the mirror step only, never stored as-is. */
  url: string;
  /** The MusicBrainz release the artwork belongs to. */
  releaseMbid: string;
  licence: ImageLicence;
}

/**
 * The archive-level terms recorded for every CAA image.
 *
 * A constant, and labelled as one. `attribution` names the archive because there
 * is no per-image author to name, and `sourceUrl` is the release page rather
 * than the image so a reviewer can see what the artwork is artwork OF.
 */
function coverArtLicence(releaseMbid: string): ImageLicence {
  return {
    licence: 'cover-art-archive-terms',
    licenceUrl: 'https://musicbrainz.org/doc/Cover_Art_Archive',
    attribution: 'Cover Art Archive',
    sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`,
  };
}

interface CaaImageEntry {
  url: string;
  front: boolean;
  approved: boolean;
}

function readImageEntry(raw: unknown): CaaImageEntry | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;

  const thumbnails = asRecord(record.thumbnails) ?? {};
  let url: string | undefined;
  for (const size of THUMBNAIL_PREFERENCE) {
    url = asString(thumbnails[size]);
    if (url) break;
  }
  // Fall back to the full-size image when no thumbnail was generated.
  url ??= asString(record.image);
  if (!url) return undefined;

  const types = asArray(record.types)
    .map((type) => asString(type)?.toLowerCase())
    .filter((type): type is string => type !== undefined);

  return {
    url,
    front: record.front === true || types.includes('front'),
    approved: record.approved !== false,
  };
}

/**
 * Extract the release id CAA reports, which is not always the one asked for.
 *
 * The `release-group` endpoint answers with the artwork of whichever RELEASE in
 * that group carries it, and names that release in the response. Recording the
 * id we asked for would point the provenance link at a release that has no
 * artwork — so the response's own id wins.
 */
function releaseMbidFromResponse(body: Record<string, unknown>, fallback: string): string {
  const release = asString(body.release);
  const match = release === undefined ? null : /([0-9a-f-]{36})\/?$/i.exec(release);
  return match ? match[1] : fallback;
}

async function fetchCoverArt(path: string, mbid: string): Promise<CoverArtImage | undefined> {
  if (!MBID_PATTERN.test(mbid)) return undefined;

  const body = asRecord(await fetchEnrichmentJson(`https://coverartarchive.org/${path}/${mbid}`));
  if (!body) return undefined;

  const entries = asArray(body.images)
    .map(readImageEntry)
    .filter((entry): entry is CaaImageEntry => entry !== undefined)
    // An unapproved image is a pending edit, not artwork the archive stands
    // behind; it can be anything a contributor uploaded minutes ago.
    .filter((entry) => entry.approved);

  // Only the FRONT cover. A back cover or a picture of the disc is a legitimate
  // CAA image and completely wrong as an album's `coverArt`, so the fallback
  // when no front exists is no album — the same as no artwork at all.
  const front = entries.find((entry) => entry.front);
  if (!front) return undefined;

  const releaseMbid = releaseMbidFromResponse(body, mbid);
  return { url: front.url, releaseMbid, licence: coverArtLicence(releaseMbid) };
}

/** Front cover for a specific release — what `MUSICBRAINZ_ALBUMID` names. */
export function fetchCoverArtForRelease(releaseMbid: string): Promise<CoverArtImage | undefined> {
  return fetchCoverArt('release', releaseMbid);
}

/**
 * Front cover for a release GROUP — the fallback when a file names its release
 * group instead, or when that specific pressing has no artwork but another
 * edition of the same album does.
 */
export function fetchCoverArtForReleaseGroup(
  releaseGroupMbid: string,
): Promise<CoverArtImage | undefined> {
  return fetchCoverArt('release-group', releaseGroupMbid);
}

/** The stored shape: an external image that carries its terms with it. */
export function toAttributableImage(image: CoverArtImage): AttributableImage {
  return {
    origin: 'external',
    url: image.url,
    provider: 'cover-art-archive',
    licence: image.licence,
  };
}
