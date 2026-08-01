import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import path from 'path';
import { clear, connect, disconnect } from '../../test/mongo';
import { ArtistModel } from '../../models/CatalogEntity';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import { TrackModel } from '../../models/Track';
import { extractMetadata } from './extractMetadata';
import { ensureContributedArtist, resolveArtist } from './resolveArtist';
import { setEnrichmentFetchForTests } from './enrichmentHttp';

beforeAll(connect);
beforeEach(async () => {
  await ArtistModel.createIndexes();
});
afterEach(async () => {
  setEnrichmentFetchForTests();
  await clear();
});
afterAll(disconnect);

async function seedArtist(overrides: Record<string, unknown> = {}) {
  return ArtistModel.create({
    name: 'Nadia Ortiz',
    nameKey: 'nadia ortiz',
    source: 'upload',
    ...overrides,
  });
}

describe('resolveArtist — high confidence links an id', () => {
  it('tier 1: an ISRC on an existing catalog track', async () => {
    const artist = await seedArtist();
    await TrackModel.create({
      title: 'Midnight Ferry',
      artistId: artist._id.toString(),
      artistName: 'Nadia Ortiz',
      duration: 180,
      source: 'upload',
      externalIds: { isrc: 'ESA452300137' },
    });

    const resolution = await resolveArtist({ isrc: 'esa452300137' });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('isrc-catalog-track');
    expect(resolution.linkedArtistId).toBe(artist._id.toString());
    expect(resolution.name).toBe('Nadia Ortiz');
  });

  it('tier 2: an ISRC resolving in the registry, linked by name key', async () => {
    const artist = await seedArtist();
    await IsrcRegistryModel.create({
      isrc: 'ESA452300137',
      recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
      title: 'Midnight Ferry',
      artistCredit: 'Nadia Ortíz',
      artistCreditNameKey: 'nadia ortiz',
      releaseCount: 2,
    });

    const resolution = await resolveArtist({ isrc: 'ESA452300137' });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('isrc-registry');
    expect(resolution.linkedArtistId).toBe(artist._id.toString());
  });

  it('tier 2 stays high confidence with no artist in the catalog yet', async () => {
    await IsrcRegistryModel.create({
      isrc: 'ESA452300137',
      recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
      title: 'Midnight Ferry',
      artistCredit: 'Nobody In Our Catalog',
      artistCreditNameKey: 'nobody in our catalog',
      releaseCount: 1,
    });

    const resolution = await resolveArtist({ isrc: 'ESA452300137' });

    expect(resolution.confidence).toBe('high');
    expect(resolution.name).toBe('Nobody In Our Catalog');
    // Nothing to link to yet — a contributed profile may be created from this.
    expect(resolution.linkedArtistId).toBeUndefined();
    expect(resolution.matchedArtistId).toBeUndefined();
  });

  it('tier 3: the audio matched a catalog recording', async () => {
    const artist = await seedArtist({ name: 'Kestrel Lane', nameKey: 'kestrel lane' });
    const resolution = await resolveArtist({
      artistName: 'Whoever The Uploader Typed',
      fingerprintMatch: { artistId: artist._id.toString(), artistName: 'Kestrel Lane' },
    });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('fingerprint-catalog-track');
    expect(resolution.linkedArtistId).toBe(artist._id.toString());
    expect(resolution.name).toBe('Kestrel Lane');
  });

  it('tier 4: a MusicBrainz artist id already on a catalog artist', async () => {
    const artist = await seedArtist({
      name: 'Kestrel Lane',
      nameKey: 'kestrel lane',
      externalIds: { musicbrainzArtistId: '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8' },
    });

    const resolution = await resolveArtist({
      musicbrainzArtistId: '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8',
      artistName: 'Something Else',
    });

    expect(resolution.confidence).toBe('high');
    expect(resolution.signal).toBe('musicbrainz-artist-id');
    expect(resolution.linkedArtistId).toBe(artist._id.toString());
  });

  it('tier 4 upgrades the file\'s own name when nobody carries the id yet', async () => {
    const resolution = await resolveArtist({
      musicbrainzArtistId: '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8',
      artistName: 'Kestrel Lane',
    });

    expect(resolution.confidence).toBe('high');
    expect(resolution.name).toBe('Kestrel Lane');
    expect(resolution.linkedArtistId).toBeUndefined();
  });
});

describe('resolveArtist — medium confidence never links', () => {
  it('tier 5: a plain artist tag reports the match but does NOT link it', async () => {
    const artist = await seedArtist();
    const resolution = await resolveArtist({ artistName: 'Nadia Ortiz' });

    expect(resolution.confidence).toBe('medium');
    expect(resolution.signal).toBe('artist-tag');
    expect(resolution.name).toBe('Nadia Ortiz');
    // The contribution policy needs to know WHOSE page this would land on…
    expect(resolution.matchedArtistId).toBe(artist._id.toString());
    // …but two different people genuinely share a name, so nothing is written.
    expect(resolution.linkedArtistId).toBeUndefined();
  });

  it('tier 6: falls back to the album artist when there is no track artist', async () => {
    const resolution = await resolveArtist({ albumArtistName: 'Nadia Ortiz' });

    expect(resolution.confidence).toBe('medium');
    expect(resolution.signal).toBe('albumartist-tag');
    expect(resolution.name).toBe('Nadia Ortiz');
  });

  it('splits featured performers out of the credit and keeps them as text', async () => {
    const resolution = await resolveArtist({ artistName: 'Nadia Ortiz feat. Kofi Mensah & Ana Gil' });

    expect(resolution.name).toBe('Nadia Ortiz');
    expect(resolution.featured).toEqual(['Kofi Mensah', 'Ana Gil']);
  });
});

describe('resolveArtist — low confidence is a suggestion only', () => {
  it('tier 7: reads the artist out of a filename', async () => {
    const resolution = await resolveArtist({
      fileName: '01 - Nadia Ortiz - Midnight Ferry.mp3',
    });

    expect(resolution.confidence).toBe('low');
    expect(resolution.signal).toBe('filename');
    expect(resolution.name).toBe('Nadia Ortiz');
    expect(resolution.linkedArtistId).toBeUndefined();
  });

  it('tier 7: reads it out of a folder layout', async () => {
    const resolution = await resolveArtist({
      relativePath: 'Nadia Ortiz/Harbour Lights/03 Midnight Ferry.mp3',
      fileName: '03 Midnight Ferry.mp3',
    });

    expect(resolution.confidence).toBe('low');
    expect(resolution.signal).toBe('folder-structure');
    expect(resolution.name).toBe('Nadia Ortiz');
  });

  it('refuses to invent an artist from a filename that names only a title', async () => {
    const resolution = await resolveArtist({ fileName: 'Live At Wembley.mp3' });
    expect(resolution.confidence).toBe('none');
  });
});

describe('resolveArtist — the denylist', () => {
  const placeholders = [
    'Unknown Artist',
    'unknown',
    'Various Artists',
    'Varios artistas',
    'VA',
    '[unknown]',
    '   ',
  ];

  for (const placeholder of placeholders) {
    it(`"${placeholder}" resolves to nothing at any confidence`, async () => {
      expect((await resolveArtist({ artistName: placeholder })).confidence).toBe('none');
      expect((await resolveArtist({ albumArtistName: placeholder })).confidence).toBe('none');
      expect(
        (await resolveArtist({ fileName: `01 - ${placeholder} - Title.mp3` })).confidence,
      ).toBe('none');
    });
  }

  it('a registry credit that is a placeholder does not become an artist either', async () => {
    await IsrcRegistryModel.create({
      isrc: 'ESA452300137',
      recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
      title: 'Untitled',
      artistCredit: 'Various Artists',
      artistCreditNameKey: 'various artists',
      releaseCount: 9,
    });

    const resolution = await resolveArtist({ isrc: 'ESA452300137' });
    expect(resolution.confidence).toBe('none');
  });
});

describe('resolveArtist — a file with no artist at all', () => {
  it('extracts, resolves to nothing, and creates nothing', async () => {
    const extracted = await extractMetadata(path.join(__dirname, '__fixtures__', 'untagged.wav'));

    // Extraction itself succeeded — a locker upload of an untagged file is valid.
    expect(extracted.technical.durationSec).toBeGreaterThan(0);
    expect(extracted.artistName).toBeUndefined();

    const resolution = await resolveArtist({
      artistName: extracted.artistName,
      albumArtistName: extracted.albumArtistName,
      isrc: extracted.isrc,
      musicbrainzArtistId: extracted.musicbrainz.artistId,
    });

    expect(resolution).toEqual({ confidence: 'none', signal: 'none', featured: [] });
    expect(await ArtistModel.countDocuments()).toBe(0);
  });
});

describe('ensureContributedArtist', () => {
  it('creates a claimable, contributed profile', async () => {
    const artist = await ensureContributedArtist({
      name: 'Nobody In Our Catalog',
      musicbrainzArtistId: '0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8',
      genres: ['Indie Pop'],
    });

    if (!artist) throw new Error('expected an artist');
    expect(artist.name).toBe('Nobody In Our Catalog');
    expect(artist.nameKey).toBe('nobody in our catalog');
    expect(artist.claimable).toBe(true);
    expect(artist.origin).toBe('contributed');
    expect(artist.acceptsContributions).toBe(false);
    expect(artist.ownerOxyUserId).toBeUndefined();
    expect(artist.externalIds?.musicbrainzArtistId).toBe('0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8');
  });

  it('reuses an existing artist rather than creating a second one', async () => {
    const existing = await seedArtist();
    const artist = await ensureContributedArtist({ name: 'Nadia  Ortíz' });

    expect(artist?._id.toString()).toBe(existing._id.toString());
    expect(await ArtistModel.countDocuments()).toBe(1);
  });

  it('two concurrent contributions of the same new artist produce ONE row', async () => {
    // The unique partial index on nameKey is the arbiter; the loser must read the
    // winner's row rather than leaving a duplicate no later write could merge.
    const [a, b] = await Promise.all([
      ensureContributedArtist({ name: 'Simultaneous Band' }),
      ensureContributedArtist({ name: 'Simultaneous Band' }),
    ]);

    expect(await ArtistModel.countDocuments()).toBe(1);
    expect(a?._id.toString()).toBe(b?._id.toString() ?? '');
  });

  /**
   * REACHABILITY, end to end. The enrichment stack was twice reported complete
   * while nothing in production ever called it — the modules existed, typechecked
   * and tested, and no contributed profile ever got a photo.
   *
   * `deliver` has no Redis here, so it runs the job in-process: this asserts the
   * real chain — create a contributed artist → enqueue → the queue dispatches to
   * `enrichArtistProfile` → the profile is filled. The enrichment HTTP layer is
   * stubbed to a fixed payload so the assertion is about the WIRING, not about
   * Wikidata being up.
   */
  it('a contributed artist with a MusicBrainz id actually reaches enrichment', async () => {
    setEnrichmentFetchForTests(async (url) => {
      if (url.includes('list=search')) return { query: { search: [{ title: 'Q1299' }] } };
      if (url.includes('Special:EntityData')) {
        return {
          entities: {
            Q1299: {
              claims: {},
              labels: { en: { value: 'The Beatles' } },
              descriptions: { en: { value: 'English pop rock band' } },
            },
          },
        };
      }
      return undefined;
    });

    const artist = await ensureContributedArtist({
      name: 'Enrichment Reachability',
      musicbrainzArtistId: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d',
    });
    if (!artist) throw new Error('expected an artist');

    // The enqueue is deliberately not awaited in production — an upload must not
    // wait on a rate-limited API — so poll rather than assume it has landed.
    let enriched: string | undefined;
    for (let attempt = 0; attempt < 40 && enriched === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      enriched = (await ArtistModel.findById(artist._id))?.bio;
    }

    expect(enriched).toBe('English pop rock band');
  });

  it('does NOT enqueue enrichment for a name-only artist', async () => {
    // Enrichment refuses any artist without a verified MBID, so queueing one
    // schedules work guaranteed to do nothing.
    const requested: string[] = [];
    setEnrichmentFetchForTests(async (url) => {
      requested.push(url);
      return undefined;
    });

    await ensureContributedArtist({ name: 'No Identifier Here' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requested).toEqual([]);
  });

  it('refuses a denylisted name', async () => {
    expect(await ensureContributedArtist({ name: 'Various Artists' })).toBeNull();
    expect(await ensureContributedArtist({ name: '' })).toBeNull();
    expect(await ArtistModel.countDocuments()).toBe(0);
  });

  it('stores only the primary artist, not the whole feature credit', async () => {
    const artist = await ensureContributedArtist({ name: 'Nadia Ortiz feat. Kofi Mensah' });
    expect(artist?.name).toBe('Nadia Ortiz');
  });
});
