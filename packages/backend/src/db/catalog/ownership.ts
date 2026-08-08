/**
 * Ownership resolution for creator-owned catalog writes — the drizzle
 * replacement for `utils/catalogOwnership.ts`.
 *
 * Every creator edit/unpublish resolves the owner from the AUTHENTICATED user
 * plus the STORED row — never from the request body. A caller cannot acquire
 * write access by sending someone else's `artistId`, because the id is read off
 * the persisted track or album and then matched against `owner_oxy_user_id`
 * server-side.
 */

import { and, eq } from 'drizzle-orm';
import { catalogEntities } from '../schema/catalog';
import { getDb } from '../postgres';

/**
 * The owner columns a write needs — named, not a whole-row read.
 *
 * `name` is here because the two CREATE paths (`createAlbum`, `uploadTrack`)
 * denormalise it onto the row they write: `albums.artist_name` and
 * `tracks.artist_name` are both `NOT NULL`. The Mongo helper projected
 * `_id ownerOxyUserId uploadsDisabled` and both controllers therefore issued a
 * SECOND `findOne` for the same document to get the name. One read answers both
 * questions.
 */
export interface OwnedArtist {
  readonly id: string;
  readonly name: string;
  readonly ownerOxyUserId: string | null;
  readonly uploadsDisabled: boolean | null;
}

/**
 * Return the artist profile `userId` owns, or null when they do not own it (or
 * it does not exist). Callers translate null into 403 — deliberately not
 * distinguishing "missing" from "not yours", so this cannot be used to probe
 * which artist ids exist.
 *
 * `type = 'artist'` is written out. Mongoose's discriminator injected it into
 * `find()` invisibly; `catalog_entities` holds persons in the same table, and
 * without this condition a person row sharing an owner would resolve as an
 * artist.
 */
export async function findOwnedArtist(
  artistId: string,
  userId: string
): Promise<OwnedArtist | null> {
  const [row] = await getDb()
    .select({
      id: catalogEntities.id,
      name: catalogEntities.name,
      ownerOxyUserId: catalogEntities.ownerOxyUserId,
      uploadsDisabled: catalogEntities.uploadsDisabled,
    })
    .from(catalogEntities)
    .where(
      and(
        eq(catalogEntities.id, artistId),
        eq(catalogEntities.type, 'artist'),
        eq(catalogEntities.ownerOxyUserId, userId)
      )
    )
    .limit(1);

  return row ?? null;
}
