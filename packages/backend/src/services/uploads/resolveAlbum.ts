/**
 * Which release is this track from?
 *
 * Same shape as artist resolution — signals ranked by trust, and only a high
 * confidence one may be written — but with a constraint the artist side does not
 * have: **`Album.coverArt` is required.** No cover art means no album. The tracks
 * simply sit loose under the artist, which is a perfectly good catalog state.
 *
 * A placeholder image would be the tempting alternative and it is the one thing
 * that must never happen: a generated grey square becomes the album's real cover
 * the moment it is written, every surface renders it, and there is no way
 * afterwards to tell a placeholder from a release that genuinely looks like
 * that. Missing art is recoverable; invented art is not.
 *
 * The second rule is grouping: a multi-file upload must produce ONE album, not
 * one per file. `buildAlbumKey` is that key, and it is computed BEFORE anything
 * touches the database so the grouping is decided in memory and the album is
 * created once.
 */

import { eq, type SQL } from 'drizzle-orm';
import type { Album, CatalogImageSizes, ImageLicence } from '@syra/shared-types';
import { buildAlbumKey, isDenylistedArtistName, normalizeNameKey } from '@syra/shared-types';
import { isUniqueViolation } from '@oxyhq/db';
import { getDb } from '../../db/postgres';
import { albumSources, albums } from '../../db/schema/catalog';
import { setAlbumGenres } from '../../db/catalog/genres';
import { recoverCoverArt } from './enrichCatalogEntity';

export type AlbumType = Album['type'];

export type AlbumConfidence = 'high' | 'medium' | 'none';

export type AlbumSignal =
  | 'upc'
  | 'musicbrainz-release-id'
  | 'album-key'
  | 'none';

export interface AlbumResolution {
  confidence: AlbumConfidence;
  signal: AlbumSignal;
  /** The release title as it should be displayed. */
  title?: string;
  /** `buildAlbumKey(albumArtist, album, year)` — the grouping key. */
  albumKey?: string;
  /** An existing album the signal points at, at any confidence. */
  matchedAlbumId?: string;
  /**
   * The album id that may be written to `Track.albumId`. Populated ONLY at high
   * confidence, so a medium-confidence name collision cannot be written by
   * forgetting to check.
   */
  linkedAlbumId?: string;
  /** Classification from the tags, for a container that has to be created. */
  type: AlbumType;
  /** From the right-hand side of `TRCK` (`3/12`) — never a count of files. */
  totalTracks?: number;
}

export interface AlbumResolutionInput {
  albumName?: string;
  albumArtistName?: string;
  /**
   * The resolved artist, when one was resolved.
   *
   * Not a signal of its own — it narrows tier 3. An album belongs to an artist,
   * `Album.artistId` is indexed, and the alternative is scanning the collection
   * to compare normalised titles, which is exactly the shape `AGENTS.md` warns
   * about for the container pipelines.
   */
  artistId?: string;
  year?: number;
  /** `BARCODE` / `UPC`. */
  upc?: string;
  musicbrainzReleaseId?: string;
  /** `TRCK`'s right-hand side. */
  totalTracks?: number;
  /** Total running time of the whole release, when a multi-file upload knows it. */
  totalDurationSec?: number;
  /** `TCMP` / `cpil`. */
  compilation?: boolean;
}

// ── Classification ──────────────────────────────────────────────────────────

/** An EP runs short; past this a release of any length is an album. */
const EP_MAX_DURATION_SEC = 30 * 60;
const SINGLE_MAX_TRACKS = 2;
const EP_MAX_TRACKS = 6;

/**
 * Classify a release from what the tags say.
 *
 * A "Various Artists" album artist means compilation, and this is the ONE place
 * a denylisted name is useful rather than dangerous: it still may not become a
 * `CatalogEntity`, but as a signal about the RELEASE it is exactly right.
 *
 * `album` is the default whenever the tags are silent. Guessing `single` from a
 * lone uploaded file would be wrong for every track someone uploads one at a
 * time, which is most of them.
 */
export function classifyAlbumType(input: AlbumResolutionInput): AlbumType {
  if (input.compilation) return 'compilation';
  if (input.albumArtistName && isDenylistedArtistName(input.albumArtistName)) return 'compilation';

  const { totalTracks, totalDurationSec } = input;
  if (totalTracks !== undefined) {
    if (totalTracks <= SINGLE_MAX_TRACKS) return 'single';
    if (totalTracks <= EP_MAX_TRACKS) return 'ep';
    if (totalDurationSec !== undefined && totalDurationSec < EP_MAX_DURATION_SEC) return 'ep';
  }
  return 'album';
}

// ── The chain ───────────────────────────────────────────────────────────────

const NOTHING: AlbumResolution = { confidence: 'none', signal: 'none', type: 'album' };

/** The id of the first album matching `where`, or null. */
async function findAlbumIdBy(where: SQL): Promise<string | null> {
  const [row] = await getDb().select({ id: albums.id }).from(albums).where(where).limit(1);
  return row?.id ?? null;
}

/**
 * Resolve the album for one file (or one already-grouped set of files).
 *
 * Tier 1 `upc` and tier 2 `musicbrainzReleaseId` are strong release identifiers,
 * both carrying sparse-unique indexes, so a hit is the release. Tier 3 is the
 * `(album artist, album, year)` key, which is a name comparison and therefore
 * medium: two different artists genuinely release albums with the same title in
 * the same year, and `albumKey` includes the artist precisely so that stays rare
 * rather than impossible.
 */
export async function resolveAlbum(input: AlbumResolutionInput): Promise<AlbumResolution> {
  const type = classifyAlbumType(input);
  const title = input.albumName?.trim();
  if (!title) return { ...NOTHING, type };

  const albumKey = buildAlbumKey({
    albumArtistName: input.albumArtistName,
    albumName: title,
    year: input.year,
  });
  const base: AlbumResolution = {
    confidence: 'none',
    signal: 'none',
    title,
    albumKey,
    type,
    ...(input.totalTracks !== undefined && { totalTracks: input.totalTracks }),
  };

  // ── 1: UPC / barcode ──
  if (input.upc) {
    const byUpc = await findAlbumIdBy(eq(albums.upc, input.upc));
    if (byUpc) {
      const id = byUpc;
      return { ...base, confidence: 'high', signal: 'upc', matchedAlbumId: id, linkedAlbumId: id };
    }
  }

  // ── 2: MusicBrainz release id ──
  if (input.musicbrainzReleaseId) {
    const byRelease = await findAlbumIdBy(
      eq(albums.externalMusicbrainzReleaseId, input.musicbrainzReleaseId)
    );
    if (byRelease) {
      const id = byRelease;
      return {
        ...base,
        confidence: 'high',
        signal: 'musicbrainz-release-id',
        matchedAlbumId: id,
        linkedAlbumId: id,
      };
    }
  }

  // ── 3: album artist + title + year ──
  //
  // `Album` stores no `albumKey` column, so the key's three components are
  // compared in-process — the stored title and artist name are raw text and
  // normalising them inside the query would need an index nobody has. What is
  // NOT done in-process is the narrowing: candidates come from an indexed field
  // (`artistId` when the artist resolved, `title` otherwise) so this never
  // becomes a collection scan.
  const artistNameKey = input.albumArtistName ? normalizeNameKey(input.albumArtistName) : undefined;
  const titleKey = normalizeNameKey(title);
  const candidates = await getDb()
    .select({
      id: albums.id,
      title: albums.title,
      artistName: albums.artistName,
      releaseDate: albums.releaseDate,
    })
    .from(albums)
    .where(input.artistId ? eq(albums.artistId, input.artistId) : eq(albums.title, title));

  for (const candidate of candidates) {
    if (normalizeNameKey(candidate.title) !== titleKey) continue;
    if (artistNameKey !== undefined && normalizeNameKey(candidate.artistName) !== artistNameKey) continue;
    if (input.year !== undefined) {
      const candidateYear = Number(candidate.releaseDate.slice(0, 4));
      if (Number.isFinite(candidateYear) && candidateYear !== input.year) continue;
    }
    return {
      ...base,
      confidence: 'medium',
      signal: 'album-key',
      matchedAlbumId: candidate.id,
    };
  }

  return base;
}

// ── Creating a contributed album ────────────────────────────────────────────

export interface ContributedAlbumInput {
  title: string;
  /** A HIGH-confidence artist. An album under an unlinked artist is not creatable. */
  artistId: string;
  artistName: string;
  /**
   * An already-uploaded image id — the embedded cover art, put through
   * `POST /images/upload` by the caller.
   *
   * Optional in the signature and fatal to creation when absent, which is the
   * whole point: this function returns `null` rather than inventing anything.
   */
  coverArt?: string;
  /** ISO date string. `Album.releaseDate` is required, so an undated release cannot be created. */
  releaseDate?: string;
  type?: AlbumType;
  totalTracks?: number;
  totalDurationSec?: number;
  genres?: string[];
  upc?: string;
  musicbrainzReleaseId?: string;
  /**
   * The release GROUP, when the file names one.
   *
   * A second chance at artwork rather than a duplicate of the release id: a
   * specific pressing frequently carries no cover in the archive while another
   * edition of the same album does.
   */
  musicbrainzReleaseGroupId?: string;
  label?: string;
  copyright?: string;
  isExplicit?: boolean;
}

/**
 * Create the album container for a contribution, or decline to.
 *
 * Returns `null` — leaving the tracks loose under the artist — when the release
 * has no cover art or no date. Both are required columns, and the only ways to
 * satisfy them without the file supplying them are inventing a placeholder image
 * and inventing a date, which are exactly the two irreversible lies this
 * function exists to refuse.
 *
 * The cover art follows the plan's preference order. The caller supplies the
 * file's own embedded front cover when it has one; failing that, this reaches
 * for Cover Art Archive by release id, which is why a Picard-tagged file with no
 * artwork can still produce an album. When neither yields anything the answer is
 * no album — never a generated placeholder, which becomes the release's real
 * cover the moment it is written and can never be told apart from one afterwards.
 */
export async function ensureContributedAlbum(
  input: ContributedAlbumInput,
): Promise<ContributedAlbum | null> {
  const title = input.title.trim();
  if (!title) return null;
  // Bound to a local before the guard: `albums.release_date` is NOT NULL, and a
  // narrowing on `input.releaseDate` does not survive into the transaction
  // callback below, where the insert actually reads it.
  const releaseDate = input.releaseDate;
  if (!releaseDate) return null;

  let coverArt = input.coverArt;
  let coverArtSizes: CatalogImageSizes | undefined;
  let coverArtLicence: ImageLicence | undefined;

  if (!coverArt && (input.musicbrainzReleaseId || input.musicbrainzReleaseGroupId)) {
    const recovered = await recoverCoverArt({
      releaseMbid: input.musicbrainzReleaseId,
      releaseGroupMbid: input.musicbrainzReleaseGroupId,
      externalId: input.musicbrainzReleaseId ?? input.musicbrainzReleaseGroupId ?? title,
    });
    if (recovered) {
      coverArt = recovered.coverArt;
      coverArtSizes = recovered.imageSizes;
      coverArtLicence = recovered.licence;
    }
  }

  if (!coverArt) return null;

  const provenanceExternalId =
    input.musicbrainzReleaseId ?? input.musicbrainzReleaseGroupId ?? title;

  try {
    /**
     * The album row, its provenance entry and its genre links commit TOGETHER.
     * All three were one `AlbumModel.create()` under Mongo because the last two
     * were embedded arrays; they are child tables now, and a partial write
     * would leave a release whose cover art has no recorded licence — the one
     * fact `sources` exists to carry.
     */
    return await getDb().transaction(async (tx) => {
      const [created] = await tx
        .insert(albums)
        .values({
          title,
          artistId: input.artistId,
          artistName: input.artistName,
          releaseDate,
          coverArtId: coverArt,
          ...coverArtSizeIds(coverArtSizes),
          /**
           * `coverArtLicence` is NOT written here, and that is parity rather
           * than an oversight of this port: the Mongo version recovered a
           * licence from Cover Art Archive and used it only to decide whether
           * to record a `sources` entry, never storing the licence itself.
           * Nothing in production writes `albums.cover_art_licence_*` — the
           * only writer anywhere is `models/Album.test.ts`. Reported rather
           * than fixed, because storing it changes what `toAlbumDto` puts on
           * the wire and that is a contract decision, not a translation.
           */
          type: input.type ?? 'album',
          source: 'upload',
          totalTracks: input.totalTracks,
          totalDuration: input.totalDurationSec,
          upc: input.upc,
          externalMusicbrainzReleaseId: input.musicbrainzReleaseId,
          label: input.label,
          copyright: input.copyright,
          isExplicit: input.isExplicit,
        })
        .returning({ id: albums.id, title: albums.title });

      if (!created) throw new Error(`Failed to create contributed album "${title}"`);

      if (coverArtLicence !== undefined) {
        await tx.insert(albumSources).values({
          albumId: created.id,
          position: 0,
          provider: 'cover-art-archive',
          externalId: provenanceExternalId,
          importedAt: new Date(),
          fields: ['coverArt'],
        });
      }

      if (input.genres?.length) {
        await setAlbumGenres(tx, created.id, input.genres);
      }

      return created;
    });
  } catch (err) {
    // `upc` and `external_musicbrainz_release_id` are the only unique keys on
    // `albums`, so two uploads of the same release racing here end with one
    // album and the loser reading the winner's row — the same arbitration the
    // artist side uses. Each branch names its OWN constraint rather than
    // testing "some unique index rejected this": a violation of the other key
    // must not be answered with a lookup on a value that was never the cause.
    if (input.upc && isUniqueViolation(err, 'albums_upc_key')) {
      const winner = await findAlbumBy(eq(albums.upc, input.upc));
      if (winner) return winner;
    }
    if (
      input.musicbrainzReleaseId &&
      isUniqueViolation(err, 'albums_external_musicbrainz_release_id_key')
    ) {
      const winner = await findAlbumBy(
        eq(albums.externalMusicbrainzReleaseId, input.musicbrainzReleaseId)
      );
      if (winner) return winner;
    }
    throw err;
  }
}

/** The `albums` row this module returns — never the whole row. */
export interface ContributedAlbum {
  id: string;
  title: string;
}

async function findAlbumBy(where: SQL): Promise<ContributedAlbum | null> {
  const [row] = await getDb()
    .select({ id: albums.id, title: albums.title })
    .from(albums)
    .where(where)
    .limit(1);

  return row ?? null;
}

/**
 * `CatalogImageSizes` to the six per-variant FK columns.
 *
 * Every key is emitted, `null` included, so an album re-created without a given
 * variant does not silently inherit the column's absence as "unchanged".
 */
function coverArtSizeIds(sizes: CatalogImageSizes | undefined): {
  coverArtSizesSmallId: string | null;
  coverArtSizesMediumId: string | null;
  coverArtSizesLargeId: string | null;
  coverArtSizesXlargeId: string | null;
  coverArtSizesXxlargeId: string | null;
  coverArtSizesOriginalId: string | null;
} {
  return {
    coverArtSizesSmallId: sizes?.small?.id ?? null,
    coverArtSizesMediumId: sizes?.medium?.id ?? null,
    coverArtSizesLargeId: sizes?.large?.id ?? null,
    coverArtSizesXlargeId: sizes?.xlarge?.id ?? null,
    coverArtSizesXxlargeId: sizes?.xxlarge?.id ?? null,
    coverArtSizesOriginalId: sizes?.original?.id ?? null,
  };
}
