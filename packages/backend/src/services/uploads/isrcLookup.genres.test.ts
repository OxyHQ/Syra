/**
 * Release genres, recovered from the identifier.
 *
 * `/browse` is built entirely from the genres of the catalogue's tracks, so a
 * catalogue of ungenred files renders an empty browse screen however much music
 * it holds — which is exactly what happened. These assert the parser reads the
 * shape Deezer actually returns, and reads nothing it must not.
 */
import { describe, it, expect } from 'bun:test';
import { parseDeezerAlbumGenres, parseDeezerAlbumTrackCount } from './isrcLookup';

describe('parseDeezerAlbumGenres', () => {
  it('reads the release genres Deezer nests under `genres.data`', () => {
    expect(
      parseDeezerAlbumGenres({
        id: 996677771,
        nb_tracks: 9,
        genres: { data: [{ id: 132, name: 'Pop' }, { id: 152, name: 'Rock' }] },
      }),
    ).toEqual(['Pop', 'Rock']);
  });

  it('collapses the repeats a release carries across its sub-entries', () => {
    expect(
      parseDeezerAlbumGenres({
        genres: { data: [{ id: 132, name: 'Pop' }, { id: 132, name: 'Pop' }] },
      }),
    ).toEqual(['Pop']);
  });

  it('reads nothing from the error object Deezer returns with a 200', () => {
    // The failure mode the whole module is written around: Deezer answers an
    // unknown id with `200 OK` and an error OBJECT, so a parser that trusted the
    // status would report a release with no fields as a successful resolution.
    const payload = { error: { type: 'DataException', message: 'no data', code: 800 } };
    expect(parseDeezerAlbumGenres(payload)).toEqual([]);
    expect(parseDeezerAlbumTrackCount(payload)).toBeUndefined();
  });

  it('never reads the artwork carried in the same payload', () => {
    // Deezer's release payload carries `cover`, `cover_small` … `cover_xl`
    // beside the genres. Their terms cover metadata; artwork is licensed per
    // work. Nothing in the parsed result may echo one.
    const parsed = parseDeezerAlbumGenres({
      cover: 'https://api.deezer.com/album/996677771/image',
      cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover/x/1000x1000.jpg',
      genres: { data: [{ id: 132, name: 'Pop' }] },
    });
    expect(parsed).toEqual(['Pop']);
    expect(JSON.stringify(parsed)).not.toContain('dzcdn');
  });

  it('survives the shapes a malformed payload can take', () => {
    expect(parseDeezerAlbumGenres(undefined)).toEqual([]);
    expect(parseDeezerAlbumGenres({ genres: null })).toEqual([]);
    expect(parseDeezerAlbumGenres({ genres: { data: 'Pop' } })).toEqual([]);
    expect(parseDeezerAlbumGenres({ genres: { data: [{ id: 1 }] } })).toEqual([]);
  });
});
