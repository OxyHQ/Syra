import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { AlbumModel } from './Album';

beforeAll(connect);

/**
 * Build the indexes before every test. Mongoose's background `autoIndex`
 * otherwise races the first insert, so a uniqueness assertion would pass on
 * timing rather than on the constraint. `createIndexes()` is idempotent.
 */
beforeEach(async () => {
  await AlbumModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

function album(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Kid A',
    artistId: 'artist-1',
    artistName: 'Radiohead',
    releaseDate: '2000-10-02',
    coverArt: '507f1f77bcf86cd799439011',
    ...overrides,
  };
}

describe('Album dedup keys', () => {
  it('rejects a second release with the same MusicBrainz release id', async () => {
    await AlbumModel.create(album({ externalIds: { musicbrainzReleaseId: 'release-mbid-1' } }));

    // Two concurrent uploads of the same release must not each create an album.
    // The loser reads the E11000 and uses the winner's row, exactly as `upc`
    // already works — dedup tier 2, behind the barcode.
    await expect(
      AlbumModel.create(
        album({ title: 'Kid A (reissue)', externalIds: { musicbrainzReleaseId: 'release-mbid-1' } }),
      ),
    ).rejects.toThrow();
  });

  it('lets releases WITHOUT an MBID coexist', async () => {
    // Sparse, because most releases carry no MBID at all — they must not all
    // collide on a single missing-value slot.
    await AlbumModel.create(album({ title: 'One' }));
    await AlbumModel.create(album({ title: 'Two' }));

    expect(await AlbumModel.countDocuments({})).toBe(2);
  });

  it('still enforces the pre-existing UPC uniqueness (dedup tier 1)', async () => {
    await AlbumModel.create(album({ upc: '0634904078164' }));

    await expect(
      AlbumModel.create(album({ title: 'Same barcode', upc: '0634904078164' })),
    ).rejects.toThrow();
  });
});

describe('Album cover art', () => {
  it('refuses to create an album with no cover art', async () => {
    // Load-bearing, not incidental: an album without real art is not created at
    // all — its tracks stay individually discoverable under the artist. A
    // placeholder is indistinguishable from real art at every later read, so it
    // could never be cleaned up.
    await expect(AlbumModel.create(album({ coverArt: undefined }))).rejects.toThrow();
  });
});

describe('Album edition facts', () => {
  it('persists the captured edition metadata', async () => {
    const saved = await AlbumModel.create(
      album({
        totalTracks: 10,
        totalDiscs: 1,
        catalogNumber: 'PARLOPHONE-7243',
        media: 'CD',
        releaseCountry: 'GB',
        originalReleaseDate: '2000',
        externalIds: { musicbrainzReleaseId: 'release-mbid-2' },
      }),
    );

    expect(saved.totalDiscs).toBe(1);
    expect(saved.catalogNumber).toBe('PARLOPHONE-7243');
    expect(saved.media).toBe('CD');
    expect(saved.releaseCountry).toBe('GB');
    expect(saved.originalReleaseDate).toBe('2000');
    expect(saved.externalIds?.musicbrainzReleaseId).toBe('release-mbid-2');
  });
});

describe('Album cover art licence and provenance', () => {
  it('stores the Cover Art Archive licence beside the cover it belongs to', async () => {
    // Without this field the importer must skip the image (its rule is: a licence
    // it cannot store means it does not import), and since `coverArt` is required
    // the album would never be created — the exact blocker CAA exists to clear.
    const saved = await AlbumModel.create(
      album({
        coverArtLicence: {
          licence: 'CC-BY-SA-4.0',
          licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
          attribution: 'Cover Art Archive contributor',
          sourceUrl: 'https://coverartarchive.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd',
        },
      }),
    );

    expect(saved.coverArtLicence?.attribution).toBe('Cover Art Archive contributor');
    expect(saved.coverArtLicence?.licence).toBe('CC-BY-SA-4.0');
  });

  it('records WHICH external source supplied a field', async () => {
    // `sources[].provider` is the audit trail a claiming artist reads to see what
    // was filled in from outside. Restricted to 'upload' | 'cc' it could not name
    // MusicBrainz or Commons at all, so the record said nothing.
    const saved = await AlbumModel.create(
      album({
        sources: [
          { provider: 'musicbrainz', externalId: 'release-mbid-3', importedAt: '2026-08-01', fields: ['label', 'catalogNumber'] },
          { provider: 'cover-art-archive', externalId: 'release-mbid-3', importedAt: '2026-08-01', fields: ['coverArt'] },
        ],
      }),
    );

    expect(saved.sources?.map((source) => source.provider)).toEqual(['musicbrainz', 'cover-art-archive']);
    expect(saved.sources?.[0]?.fields).toEqual(['label', 'catalogNumber']);
  });

  it('still rejects a provider that is not a known source', async () => {
    // Vacuity floor: widening the enum must not have turned it into a free string.
    await expect(
      AlbumModel.create(
        album({
          sources: [{ provider: 'spotify', externalId: 'x', importedAt: '2026-08-01', fields: ['label'] }],
        }),
      ),
    ).rejects.toThrow();
  });
});
