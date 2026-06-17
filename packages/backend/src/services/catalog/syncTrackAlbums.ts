import type { CatalogSource, ExternalAlbum, ExternalTrack } from '@syra/shared-types';
import { upsertArtist } from './upsertArtist';
import { upsertAlbum } from './upsertAlbum';

interface AlbumGroup {
  album: ExternalAlbum;
  tracks: ExternalTrack[];
}

function mergeAlbumFromTrack(track: ExternalTrack): ExternalAlbum | undefined {
  const album = track.album;
  if (!album?.externalId || !album.name.trim()) return undefined;

  return {
    ...album,
    images: album.images?.length ? album.images : track.images,
    genre: album.genre ?? track.genre,
    releaseDate: album.releaseDate ?? track.releaseDate,
  };
}

export async function syncAlbumsForTracks(
  tracks: ExternalTrack[],
  source: CatalogSource,
): Promise<number> {
  const groups = new Map<string, AlbumGroup>();

  for (const track of tracks) {
    const album = mergeAlbumFromTrack(track);
    if (!album || !track.artists.length) continue;

    const existing = groups.get(album.externalId);
    if (existing) {
      existing.tracks.push(track);
      continue;
    }

    groups.set(album.externalId, { album, tracks: [track] });
  }

  let synced = 0;

  for (const { album, tracks: groupTracks } of groups.values()) {
    const primaryArtist = groupTracks[0]?.artists[0];
    if (!primaryArtist) continue;

    const { artist } = await upsertArtist(primaryArtist, source);
    const trackExternalIds = [...new Set(groupTracks.map((track) => track.externalId))];
    const { album: saved } = await upsertAlbum(
      {
        ...album,
        trackExternalIds,
        tracks: groupTracks,
      },
      { artistId: artist._id.toString(), artistName: artist.name },
      source,
    );

    if (saved) synced += 1;
  }

  return synced;
}
