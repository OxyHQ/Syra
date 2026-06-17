const albumImageFirstSort = {
  coverArt: -1,
  'images.0.url': -1,
} as const;

const artistImageFirstSort = {
  image: -1,
  'images.0.url': -1,
} as const;

const playlistImageFirstSort = {
  coverArt: -1,
  'images.0.url': -1,
} as const;

const trackImageFirstSort = {
  coverArt: -1,
  'images.0.url': -1,
} as const;

export type ImageFirstEntity = 'album' | 'artist' | 'playlist' | 'track';

const SORT_BY_ENTITY = {
  album: albumImageFirstSort,
  artist: artistImageFirstSort,
  playlist: playlistImageFirstSort,
  track: trackImageFirstSort,
} as const;

export function withImageFirstSort<T extends Record<string, 1 | -1>>(
  entity: ImageFirstEntity,
  sort: T,
): Record<string, 1 | -1> {
  return {
    ...SORT_BY_ENTITY[entity],
    ...sort,
  };
}
