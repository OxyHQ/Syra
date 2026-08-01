import { describe, it, expect } from 'bun:test';
import {
  normalizeNameKey,
  isDenylistedArtistName,
  buildAlbumKey,
  DENYLISTED_ARTIST_NAME_KEYS,
} from './nameKey';

/**
 * The normaliser is the one thing in this design that cannot be allowed to
 * drift: it decides whether two names are the same identity, and because artist
 * `nameKey` carries a unique index, every wrong answer is either a duplicate
 * nobody can merge afterwards or an artist nobody can create.
 */

describe('normalizeNameKey', () => {
  it('strips diacritics so accented and unaccented spellings agree', () => {
    expect(normalizeNameKey('Ramón')).toBe('ramon');
    expect(normalizeNameKey('Ramon')).toBe('ramon');
    expect(normalizeNameKey('Björk')).toBe('bjork');
    expect(normalizeNameKey('Sigur Rós')).toBe('sigur ros');
    expect(normalizeNameKey('Café Tacvba')).toBe('cafe tacvba');
  });

  it('folds case', () => {
    expect(normalizeNameKey('RADIOHEAD')).toBe('radiohead');
    expect(normalizeNameKey('RaDiOhEaD')).toBe('radiohead');
  });

  it('turns punctuation into a separator rather than deleting it', () => {
    // Deleting would fuse the words, so `Simon & Garfunkel` would stop matching
    // the same name written any other way.
    expect(normalizeNameKey('Simon & Garfunkel')).toBe('simon garfunkel');
    expect(normalizeNameKey('A.C. Newman')).toBe('a c newman');
    expect(normalizeNameKey('AC/DC')).toBe('ac dc');
    expect(normalizeNameKey('Godspeed You! Black Emperor')).toBe('godspeed you black emperor');
  });

  it('normalises typographic punctuation to the same key as its ASCII spelling', () => {
    expect(normalizeNameKey('O’Brien')).toBe(normalizeNameKey("O'Brien"));
    expect(normalizeNameKey('Sigur Rós — Live')).toBe(normalizeNameKey('Sigur Ros - Live'));
    expect(normalizeNameKey('“Weird Al” Yankovic')).toBe(normalizeNameKey('"Weird Al" Yankovic'));
  });

  it('folds unicode width variants onto plain ASCII', () => {
    // Full-width Latin is a compatibility form, so NFKD folds it. A tagger that
    // wrote a name in full-width must not create a second artist.
    expect(normalizeNameKey('Ｒａｄｉｏｈｅａｄ')).toBe('radiohead');
    expect(normalizeNameKey('ＡＣ／ＤＣ')).toBe('ac dc');
  });

  it('collapses whitespace and trims', () => {
    expect(normalizeNameKey('  The   National  ')).toBe('the national');
    expect(normalizeNameKey('The\tNational\n')).toBe('the national');
    expect(normalizeNameKey('')).toBe('');
    expect(normalizeNameKey('   ')).toBe('');
  });

  it('preserves non-Latin scripts rather than transliterating or dropping them', () => {
    expect(normalizeNameKey('坂本龍一')).toBe('坂本龍一');
    expect(normalizeNameKey('ТРОЛЛЬ')).toBe('тролль');
  });

  it('strips combining marks from LATIN letters ONLY', () => {
    // Cyrillic `й` is `и` + a combining breve under NFKD, and Russian treats
    // them as different letters. Stripping it would buy nothing — the
    // inconsistent spelling people really have in their tags is a
    // TRANSLITERATION ("Mumiy Troll"), a different script that no mark-stripping
    // can merge — while costing a false merge. And because artist `nameKey` is
    // UNIQUE, a false merge does not just conflate two artists, it makes the
    // second one impossible to create at all.
    expect(normalizeNameKey('Мумий Тролль')).toBe('мумий тролль');
    expect(normalizeNameKey('Мумий Тролль')).not.toBe(normalizeNameKey('Мумии Тролль'));

    // Latin keeps the aggressive fold, where the merge is the answer you wanted.
    expect(normalizeNameKey('Björk')).toBe(normalizeNameKey('Bjork'));
    expect(normalizeNameKey('Beyoncé')).toBe(normalizeNameKey('Beyonce'));

    // And the transliteration stays distinct either way — which is the point.
    expect(normalizeNameKey('Мумий Тролль')).not.toBe(normalizeNameKey('Mumiy Troll'));
  });

  it('writes surviving marks back in precomposed (NFC) form', () => {
    // Otherwise the stored key would be `и` + U+0306: identical on screen to
    // `й`, unequal to it in a query, and impossible to spot in a document.
    expect(normalizeNameKey('Мумий')).toBe('мумий');
    expect([...normalizeNameKey('Мумий')]).toHaveLength(5);
  });

  it('is idempotent', () => {
    // Callers pass either a raw name or an existing key; a second pass must not
    // change the answer, or `isDenylistedArtistName(key)` would disagree with
    // `isDenylistedArtistName(name)`.
    for (const name of ['Ramón', 'A.C. Newman', 'Ｒａｄｉｏｈｅａｄ', '  The   National  ']) {
      const once = normalizeNameKey(name);
      expect(normalizeNameKey(once)).toBe(once);
    }
  });

  it('keeps genuinely different names apart', () => {
    // A vacuity floor: a normaliser that returned '' for everything would pass
    // every test above.
    expect(normalizeNameKey('The Beatles')).not.toBe(normalizeNameKey('The Beach Boys'));
    expect(normalizeNameKey('Bon Iver')).not.toBe(normalizeNameKey('Bon Jovi'));
    expect(new Set(['Radiohead', 'Portishead', 'Massive Attack'].map(normalizeNameKey)).size).toBe(3);
  });
});

describe('isDenylistedArtistName', () => {
  it('rejects the placeholder names a tagger writes when it has nothing', () => {
    for (const name of [
      'Unknown Artist',
      'unknown',
      'Various Artists',
      'Varios artistas',
      'VA',
      'Sin artista',
      '[unknown]',
      '',
      '   ',
    ]) {
      expect(isDenylistedArtistName(name)).toBe(true);
    }
  });

  it('rejects spellings that normalise onto a denylisted key', () => {
    // The list holds KEYS, not spellings — `V.A.` and `V/A` are not entries, they
    // normalise to `v a`, which is.
    expect(isDenylistedArtistName('V.A.')).toBe(true);
    expect(isDenylistedArtistName('V/A')).toBe(true);
    expect(isDenylistedArtistName('  UNKNOWN  ARTIST ')).toBe(true);
    expect(isDenylistedArtistName('Ｕｎｋｎｏｗｎ')).toBe(true);
  });

  it('accepts real artists', () => {
    for (const name of ['Radiohead', 'Unknown Mortal Orchestra', 'The Unknown', 'Various Production']) {
      expect(isDenylistedArtistName(name)).toBe(false);
    }
  });

  it('takes a raw name or an already-normalised key', () => {
    // A caller that forgets to normalise first must not get a silent `false` and
    // create the row the list exists to prevent.
    expect(isDenylistedArtistName('Various Artists')).toBe(true);
    expect(isDenylistedArtistName(normalizeNameKey('Various Artists'))).toBe(true);
  });

  it('holds only already-normalised keys and is not vacuous', () => {
    // An entry that is not its own normal form can never match anything, so the
    // list would look complete while silently having a hole in it.
    for (const key of DENYLISTED_ARTIST_NAME_KEYS) {
      expect(normalizeNameKey(key)).toBe(key);
    }
    expect(DENYLISTED_ARTIST_NAME_KEYS.length).toBeGreaterThan(8);
  });
});

describe('buildAlbumKey', () => {
  it('groups the tracks of one album under one key', () => {
    // A 12-file folder must produce ONE album, not twelve.
    const keys = new Set(
      ['Kid A', 'Kid A', 'Kid A'].map((albumName, index) =>
        buildAlbumKey({ albumArtistName: 'Radiohead', albumName, year: 2000 + 0 * index }),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('groups across the tagging inconsistencies that split an album', () => {
    const canonical = buildAlbumKey({ albumArtistName: 'Sigur Rós', albumName: '( )', year: 2002 });

    expect(buildAlbumKey({ albumArtistName: 'Sigur Ros', albumName: '( )', year: 2002 })).toBe(canonical);
    expect(buildAlbumKey({ albumArtistName: 'SIGUR RÓS', albumName: '()', year: 2002 })).toBe(canonical);
    expect(buildAlbumKey({ albumArtistName: ' Sigur  Rós ', albumName: '(  )', year: 2002 })).toBe(canonical);
  });

  it('separates releases that genuinely differ', () => {
    const original = buildAlbumKey({ albumArtistName: 'Portishead', albumName: 'Dummy', year: 1994 });
    const reissue = buildAlbumKey({ albumArtistName: 'Portishead', albumName: 'Dummy', year: 2014 });
    const other = buildAlbumKey({ albumArtistName: 'Portishead', albumName: 'Third', year: 2008 });
    const different = buildAlbumKey({ albumArtistName: 'Massive Attack', albumName: 'Dummy', year: 1994 });

    // A reissue IS a different release; an absent year is its own bucket rather
    // than a wildcard, or an untagged file would join a dated release by guess.
    expect(new Set([original, reissue, other, different]).size).toBe(4);
    expect(buildAlbumKey({ albumArtistName: 'Portishead', albumName: 'Dummy' })).not.toBe(original);
  });

  it('groups by ALBUM artist, so a compilation stays one album', () => {
    // Every track on a compilation has a different `artist`; only `albumartist`
    // holds them together.
    const perTrackArtists = ['Aphex Twin', 'Autechre', 'Boards of Canada'];
    const keys = new Set(
      perTrackArtists.map(() =>
        buildAlbumKey({ albumArtistName: 'Various Artists', albumName: 'Warp10', year: 1999 }),
      ),
    );
    expect(keys.size).toBe(1);
  });

  it('stays inside MongoDB index key limits for absurd tag values', () => {
    // An untruncated composite would make the INSERT fail on exactly the
    // pathological file nobody tests with (Mongo refuses index keys > 1024 B).
    const key = buildAlbumKey({
      albumArtistName: 'A'.repeat(5000),
      albumName: 'B'.repeat(5000),
      year: 1999,
    });
    expect(Buffer.byteLength(key, 'utf8')).toBeLessThan(1024);
  });

  it('handles a completely untagged file without throwing', () => {
    expect(buildAlbumKey({})).toBe('||');
  });
});
