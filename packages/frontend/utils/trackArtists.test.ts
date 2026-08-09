import type { Track } from '@syra/shared-types';
import { trackArtists, trackArtistsText } from './trackArtists';

/**
 * Every fixture here is built to sit on BOTH sides of the distinction the case
 * exists to make, because the tidy version of each one passes either way: a
 * single featured artist cannot tell "keeps the list" from "keeps the first"; a
 * credit set containing only `artist` roles cannot tell "filters by role" from
 * "does not filter"; and credits that happen to be stored in display order
 * cannot tell "principal first" from "whatever order the rows arrived in".
 */
function track(overrides: Partial<Track>): Pick<Track, 'artistId' | 'artistName' | 'credits'> {
  return {
    artistId: 'ent-principal',
    artistName: 'benny blanco',
    ...overrides,
  };
}

describe('trackArtists', () => {
  it('returns the principal alone when there are no credits', () => {
    expect(trackArtists(track({}))).toEqual([{ id: 'ent-principal', name: 'benny blanco' }]);
  });

  it('keeps EVERY featured artist, not just the first', () => {
    const artists = trackArtists(
      track({
        credits: [
          { name: 'Bb trickz', role: 'artist', nameKey: 'bb trickz', catalogEntityId: 'ent-bb' },
          { name: 'Otro', role: 'artist', nameKey: 'otro', catalogEntityId: 'ent-otro' },
        ],
      })
    );

    expect(artists.map((artist) => artist.name)).toEqual(['benny blanco', 'Bb trickz', 'Otro']);
  });

  it('leaves out roles that are not performing credits', () => {
    // The producer is FIRST in the array, so a filter that is missing shows up
    // as a name in the line rather than as an ordering difference nobody sees.
    const artists = trackArtists(
      track({
        credits: [
          { name: 'Ana Gil', role: 'producer', nameKey: 'ana gil' },
          { name: 'Bb trickz', role: 'artist', nameKey: 'bb trickz', catalogEntityId: 'ent-bb' },
        ],
      })
    );

    expect(artists.map((artist) => artist.name)).toEqual(['benny blanco', 'Bb trickz']);
  });

  it('puts the principal first even when a credit sorts before it', () => {
    const artists = trackArtists(
      track({
        artistName: 'Zeta',
        credits: [{ name: 'Alpha', role: 'artist', nameKey: 'alpha', catalogEntityId: 'ent-a' }],
      })
    );

    expect(artists.map((artist) => artist.name)).toEqual(['Zeta', 'Alpha']);
  });

  it('renders a credit with no resolved entity, WITHOUT an id to link to', () => {
    // A name off a file tag: it was really on the record, but it is not a claim
    // about which catalogue row that person is — so it shows and does not link.
    const artists = trackArtists(
      track({ credits: [{ name: 'Invitada', role: 'artist', nameKey: 'invitada' }] })
    );

    expect(artists[1]).toEqual({ name: 'Invitada' });
    expect(artists[1]).not.toHaveProperty('id');
  });

  it('never lists the principal twice, whatever case the credit was written in', () => {
    const artists = trackArtists(
      track({
        credits: [
          { name: 'BENNY BLANCO', role: 'artist', nameKey: 'benny blanco', catalogEntityId: 'x' },
        ],
      })
    );

    expect(artists).toHaveLength(1);
  });

  it('drops a blank principal rather than opening the line with a comma', () => {
    const artists = trackArtists(
      track({
        artistName: '',
        credits: [{ name: 'Bb trickz', role: 'artist', nameKey: 'bb trickz', catalogEntityId: 'b' }],
      })
    );

    expect(artists.map((artist) => artist.name)).toEqual(['Bb trickz']);
  });
});

describe('trackArtistsText', () => {
  it('joins the same list the linked line renders', () => {
    expect(
      trackArtistsText(
        track({
          credits: [
            { name: 'Bb trickz', role: 'artist', nameKey: 'bb trickz', catalogEntityId: 'ent-bb' },
            { name: 'Ana Gil', role: 'producer', nameKey: 'ana gil' },
          ],
        }),
        'fallback'
      )
    ).toBe('benny blanco, Bb trickz');
  });

  it('falls back only when there is no artist at all', () => {
    expect(trackArtistsText(track({ artistName: '' }), 'Unknown artist')).toBe('Unknown artist');
  });
});
