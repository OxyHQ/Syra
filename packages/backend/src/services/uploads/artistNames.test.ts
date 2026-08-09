import { describe, it, expect } from 'bun:test';
import { splitArtistCredit } from './artistNames';

describe('splitArtistCredit — explicit feature markers', () => {
  const cases: ReadonlyArray<readonly [string, string, string[]]> = [
    ['Nadia Ortiz feat. Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz feat Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz ft. Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz featuring Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz FEAT. Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz with Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz vs. Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    ['Nadia Ortiz w/ Kofi Mensah', 'Nadia Ortiz', ['Kofi Mensah']],
    [
      'Nadia Ortiz feat. Kofi Mensah & Ana Gil, Rocío Vela',
      'Nadia Ortiz',
      ['Kofi Mensah', 'Ana Gil', 'Rocío Vela'],
    ],
  ];

  for (const [input, primary, featured] of cases) {
    it(`"${input}"`, () => {
      expect(splitArtistCredit(input)).toEqual({ primary, featured });
    });
  }
});

describe('splitArtistCredit — names that must survive intact', () => {
  /**
   * The deliberate narrowing of the plan's separator list. Splitting on a bare
   * `&` or `,` anywhere in the string destroys every band whose name contains
   * one — and since the resulting fragments would be published as credits, the
   * damage is a permanent, visible lie about who played on a record.
   */
  const intact = [
    'Earth, Wind & Fire',
    'Emerson, Lake & Palmer',
    'Crosby, Stills & Nash',
    'Simon & Garfunkel',
    'Florence + The Machine',
    'AC/DC',
    'Hall & Oates',
    'Sly and the Family Stone',
    'Nick Cave & The Bad Seeds',
    // `with` and `vs.` genuinely open band names, which is why only
    // feat./ft./featuring are accepted at the start of a credit.
    'With Confidence',
    'Vs Self',
  ];

  for (const name of intact) {
    it(`"${name}" stays whole`, () => {
      expect(splitArtistCredit(name)).toEqual({ primary: name, featured: [] });
    });
  }

  it('does not mistake a word merely containing a marker for a marker', () => {
    expect(splitArtistCredit('Ftour Collective').primary).toBe('Ftour Collective');
    expect(splitArtistCredit('Withered Hand').primary).toBe('Withered Hand');
    expect(splitArtistCredit('Featherweight').primary).toBe('Featherweight');
  });
});

describe('splitArtistCredit — degenerate input', () => {
  it('an empty or whitespace-only credit names nobody', () => {
    expect(splitArtistCredit('')).toEqual({ primary: '', featured: [] });
    expect(splitArtistCredit('   ')).toEqual({ primary: '', featured: [] });
  });

  it('a credit that is nothing but a feature has NO primary artist', () => {
    // Promoting the guest would attribute the whole track to them.
    expect(splitArtistCredit('feat. Kofi Mensah')).toEqual({
      primary: '',
      featured: ['Kofi Mensah'],
    });
  });

  it('trims surrounding whitespace', () => {
    expect(splitArtistCredit('  Nadia Ortiz  ')).toEqual({ primary: 'Nadia Ortiz', featured: [] });
  });
});

describe('splitArtistCredit — the BRACKETED feature, which is how platforms write it', () => {
  /**
   * This block exists because a correct upload was refused in production.
   *
   * `Joven y Salvaje (with Bb trickz)` came back whole: the marker required
   * whitespace before it, and the character before `with` was `(`. The title
   * key therefore never matched the registry's `Joven y Salvaje`, and the ISRC
   * check reported "belongs to a different recording" about a file whose
   * provenance was never in doubt.
   *
   * The fixtures below are bracketed on purpose — the unbracketed spelling
   * already passed before the fix, so a suite testing only that shape cannot
   * tell the two implementations apart.
   */
  it.each([
    ['Joven y Salvaje (with Bb trickz)', 'Joven y Salvaje', ['Bb trickz']],
    ['Joven y Salvaje (feat. Bb trickz)', 'Joven y Salvaje', ['Bb trickz']],
    ['Joven y Salvaje [feat. Bb trickz]', 'Joven y Salvaje', ['Bb trickz']],
    ['Rels B (with Bb trickz, Otro)', 'Rels B', ['Bb trickz', 'Otro']],
  ])('splits %s', (raw, primary, featured) => {
    const credit = splitArtistCredit(raw as string);
    expect(credit.primary).toBe(primary);
    expect(credit.featured).toEqual(featured);
  });

  it('does not strip a closing bracket that is part of nothing', () => {
    // The bracket cleanup applies to the FEATURED remainder only; a principal
    // name is returned by a different path and must not be touched by it.
    expect(splitArtistCredit('Sunn O)))').primary).toBe('Sunn O)))');
  });
});
