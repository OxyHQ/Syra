import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { catalogEntities } from '../../db/schema/catalog';
import { playlists } from '../../db/schema/library';
import { artistCuratedPlaylists } from '../../db/schema/listener-tools';
import { findPlaylistsWithPlayableTracks } from '../../db/catalog/containers';
import { toPlaylistDtos } from '../../db/catalog/hydrate';
import { ListenerAccessError } from './access-error';

export async function readCuratedPlaylists(artistId: string) {
  const selections = await getDb().select({ playlistId: artistCuratedPlaylists.playlistId })
    .from(artistCuratedPlaylists).where(eq(artistCuratedPlaylists.artistId, artistId))
    .orderBy(asc(artistCuratedPlaylists.position)).limit(10);
  if (!selections.length) return { items: [] };
  // Public even for the owner: making a selected playlist private removes it
  // from the shelf immediately, without depending on a later cleanup job.
  const rows = await findPlaylistsWithPlayableTracks(and(
    eq(playlists.visibility, 'public'), inArray(playlists.id, selections.map((entry) => entry.playlistId)),
  ), { limit: 10, orderBy: [asc(playlists.id)] });
  const byId = new Map((await toPlaylistDtos(rows)).map((playlist) => [playlist.id, playlist]));
  return { items: selections.flatMap((entry) => {
    const playlist = byId.get(entry.playlistId);
    return playlist ? [playlist] : [];
  }) };
}

export async function selectCuratedPlaylists(artistId: string, userId: string, playlistIds: string[]) {
  await getDb().transaction(async (tx) => {
    const [artist] = await tx.select({ id: catalogEntities.id }).from(catalogEntities)
      .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist'), eq(catalogEntities.ownerOxyUserId, userId)))
      .for('update');
    if (!artist) throw new ListenerAccessError(403, 'Only the artist owner can select playlists');
    if (playlistIds.length) {
      const owned = await tx.select({ id: playlists.id }).from(playlists).where(and(
        inArray(playlists.id, playlistIds), eq(playlists.ownerOxyUserId, userId), eq(playlists.visibility, 'public'),
      ));
      if (owned.length !== playlistIds.length) throw new ListenerAccessError(400, 'Select your own public playlists');
    }
    await tx.delete(artistCuratedPlaylists).where(eq(artistCuratedPlaylists.artistId, artistId));
    if (playlistIds.length) await tx.insert(artistCuratedPlaylists).values(playlistIds.map((playlistId, position) => ({ artistId, playlistId, position })));
  });
  return readCuratedPlaylists(artistId);
}
