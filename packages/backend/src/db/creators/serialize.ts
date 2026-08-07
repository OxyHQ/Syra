/**
 * The locker's one serializer — pure, and an explicit allowlist.
 *
 * `toUploadTrackDto` lived in `controllers/uploads.controller.ts` and moved
 * here with the port, for the reason every other vertical's serializer lives
 * beside its rows: it takes a row plus an {@link ImageVariantLookup} and
 * returns a DTO, so it is testable without a database and one page can share
 * one lookup. `db/catalog/hybridServices.ts` said this file's arrival was what
 * would let `queue.controller` finish — it reads it directly from here now.
 *
 * ## It stays an ALLOWLIST, and the failure mode is the quiet one
 *
 * Every key is written out. That is what keeps a column added to
 * `user_uploads` tomorrow off the wire without anybody remembering to strip it
 * — the guard is the absence of a spread, not a `delete` list. Adding a
 * `delete` here would be worse than useless: it could never fire, and it would
 * advertise a denylist where the real guard is an allowlist.
 *
 * The cost of an allowlist is that a field it omits disappears in SILENCE,
 * where a denylist that misses one leaks loudly. `toArtistDto` was silently
 * dropping a live `members` field for exactly this reason. So the omissions
 * here are deliberate and named:
 *
 *  - **Every storage key.** `audio_source_key`, `hls_master_key` and each
 *    `user_upload_hls_renditions.manifest_key` are raw S3 object names. A
 *    locker file is reachable only through `GET /api/uploads/:id/stream`,
 *    which checks ownership; handing a client the key would be handing it a
 *    way around that check the day the bucket policy is loosened by anyone.
 *  - **`fingerprint`, `sha256` and the `rawTags*` block** — these cannot even
 *    be named here: {@link UploadRow} is built with `publicColumns`, so they
 *    are absent from the row TYPE and reaching for one fails `tsc`.
 *  - **`deletedAt` and `deletionNoticeSentAt`** — the sweeper's own state.
 *    `expiresAt` IS on the wire, because retention promises the owner a
 *    warning and a warning the client cannot render is not a warning.
 *  - **The nine edition fields, `credits`, `lyrics` and `loudnessLufs`** —
 *    nothing writes any of them (see `schema/creators.ts`), so they were
 *    absent from the Mongo DTO too. They stay absent rather than being added
 *    on the way past: a column with no writer put on the wire is a field every
 *    client learns to read as always-null.
 *
 * The omissions above are the ones the PORT decided. What it did not decide is
 * anything else: the key set here was diffed against the shipped Mongo
 * serializer's and is identical, all 24, `coverArtSizes` included — which is
 * the check an allowlist needs, because a key dropped in the move would have
 * left the wire silently one field poorer with every test still green.
 */

import type { CatalogImageSizes, UserUploadAsTrack } from '@syra/shared-types';
import { normalizeImageRef, toImageSizes, type ImageVariantLookup } from '../catalog/serialize';
import type { UploadRow } from './uploads';

/** Every `image_assets` id an upload row can reference — for `loadImageVariants`. */
export function uploadImageIds(row: UploadRow): (string | null)[] {
  return [
    row.coverArtId,
    row.coverArtSizesSmallId,
    row.coverArtSizesMediumId,
    row.coverArtSizesLargeId,
    row.coverArtSizesXlargeId,
    row.coverArtSizesXxlargeId,
    row.coverArtSizesOriginalId,
  ];
}

/**
 * A locker file in the catalogue's Track shape, tagged `kind: 'upload'`.
 *
 * `artistId` and `artistName` fall back to `''` rather than being omitted: the
 * shared Track shape requires both, an unresolved artist is a normal state for
 * a locker file, and the UI renders its own "Unknown artist" for an empty name
 * so the backend never ships a language-specific string.
 */
export function toUploadTrackDto(row: UploadRow, lookup: ImageVariantLookup): UserUploadAsTrack {
  const coverArtSizes: CatalogImageSizes | undefined = toImageSizes(
    {
      small: row.coverArtSizesSmallId,
      medium: row.coverArtSizesMediumId,
      large: row.coverArtSizesLargeId,
      xlarge: row.coverArtSizesXlargeId,
      xxlarge: row.coverArtSizesXxlargeId,
      original: row.coverArtSizesOriginalId,
    },
    lookup
  );

  return {
    kind: 'upload',
    id: row.id,
    title: row.title,
    artistId: row.resolvedArtistId ?? '',
    artistName: row.artistName ?? '',
    albumName: row.albumName ?? undefined,
    // The locker has NO albums table; album views are a grouping over this
    // key. Without it on the wire the client has to re-derive the grouping
    // from display names, which splits a compilation across its guest artists
    // and merges two same-titled releases from different years.
    albumKey: row.albumKey ?? undefined,
    albumArtistName: row.albumArtistName ?? undefined,
    duration: row.duration,
    trackNumber: row.trackNumber ?? undefined,
    discNumber: row.discNumber ?? undefined,
    coverArt: normalizeImageRef(row.coverArtId),
    coverArtSizes,
    metadata: row.genres.length > 0 ? { genre: [...row.genres] } : undefined,
    // The locker stores no advisory flag; a private file is not rated by anyone.
    isExplicit: false,
    // A soft-deleted file is past its expiry and no longer playable, so it
    // reports the same unavailability a taken-down track would.
    isAvailable: !row.deletedAt,
    source: 'upload',
    status: row.status,
    playCount: row.playCount,
    primaryColor: row.primaryColor ?? undefined,
    secondaryColor: row.secondaryColor ?? undefined,
    /**
     * When this file is due for deletion.
     *
     * User-facing, not bookkeeping: retention promises the owner a warning
     * before anything is removed, and a warning the client cannot render is
     * not a warning. The other retention stamps (`deletionNoticeSentAt`,
     * `deletedAt`) stay server-side — they are how the sweeper tracks its own
     * work.
     */
    expiresAt: row.expiresAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
