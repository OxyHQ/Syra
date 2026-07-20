import { ArtistModel } from '../models/CatalogEntity';

/**
 * Ownership resolution for creator-owned catalog writes.
 *
 * Every creator edit/unpublish resolves the owner from the AUTHENTICATED user plus the
 * STORED document — never from the request body. A caller cannot acquire write access by
 * sending someone else's `artistId`, because the id is read off the persisted track or
 * album and then matched against `ownerOxyUserId` server-side.
 */

/** The owner fields a write needs; `.lean()` shape, not a hydrated document. */
export interface OwnedArtist {
  _id: unknown;
  ownerOxyUserId?: string;
  uploadsDisabled?: boolean;
}

/**
 * Return the artist profile `userId` owns, or null when they do not own it (or it does
 * not exist). Callers translate null into 403 — deliberately not distinguishing
 * "missing" from "not yours", so this cannot be used to probe which artist ids exist.
 */
export async function findOwnedArtist(
  artistId: string,
  userId: string,
): Promise<OwnedArtist | null> {
  const artist = await ArtistModel.findOne({
    _id: artistId,
    ownerOxyUserId: userId,
  })
    .select('_id ownerOxyUserId uploadsDisabled')
    .lean();

  return artist ?? null;
}
