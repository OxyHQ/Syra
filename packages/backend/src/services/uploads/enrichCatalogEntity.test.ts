import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { clear, connect, disconnect } from '../../test/mongo';
import { AlbumModel } from '../../models/Album';
import { ArtistModel } from '../../models/CatalogEntity';
import { setEnrichmentFetchForTests } from './enrichmentHttp';
import {
  enrichAlbumCoverArt,
  enrichArtistProfile,
  recoverCoverArt,
  suggestArtistPhotosFromUpload,
  isArtistPicture,
} from './enrichCatalogEntity';
import type { ArtistPhotoSuggestionDeps } from './enrichCatalogEntity';
import { extractMetadata, type ExtractedPicture } from './extractMetadata';
import path from 'path';
import { ensureContributedAlbum } from './resolveAlbum';
import payloads from './__fixtures__/enrichment-payloads.json';

const BEATLES_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';
const RELEASE_MBID = '31765b9f-e969-4257-855f-c7ea1f657b2a';

let requestedUrls: string[] = [];

function routeToPayload(url: string): unknown | undefined {
  if (url.includes('list=search')) return payloads.wikidataSearch;
  if (url.includes('Special:EntityData')) return payloads.wikidataEntity;
  if (url.includes('action=wbgetentities')) return payloads.wikidataLabels;
  if (url.includes('commons.wikimedia.org')) return payloads.commonsImage;
  if (url.includes('coverartarchive.org')) return payloads.coverArtArchive;
  return undefined;
}

beforeAll(connect);
beforeEach(() => {
  requestedUrls = [];
  setEnrichmentFetchForTests(async (url) => {
    requestedUrls.push(url);
    return routeToPayload(url);
  });
});
afterEach(async () => {
  setEnrichmentFetchForTests();
  await clear();
});
afterAll(disconnect);

async function seedArtist(overrides: Record<string, unknown> = {}) {
  return ArtistModel.create({
    name: 'The Beatles',
    source: 'upload',
    origin: 'contributed',
    claimable: true,
    externalIds: { musicbrainzArtistId: BEATLES_MBID },
    ...overrides,
  });
}

describe('enrichArtistProfile — the high-confidence gate', () => {
  /**
   * The single most important test in this file.
   *
   * An artist resolved by NAME has no verified identity. "Nirvana", "Eclipse"
   * and "Prince" all return a real, confident, wrong Wikidata item, and a profile
   * carrying a stranger's face is worse than a blank one because it looks
   * finished. The gate is the presence of a MusicBrainz artist id, and there is
   * no name-based path to bypass it.
   */
  it('REFUSES to enrich an artist with no MusicBrainz id, and makes no request', async () => {
    const artist = await ArtistModel.create({ name: 'Nirvana', source: 'upload' });
    const result = await enrichArtistProfile(artist._id.toString());

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('MusicBrainz');
    expect(result.fieldsWritten).toEqual([]);
    expect(requestedUrls).toEqual([]);

    const after = await ArtistModel.findById(artist._id);
    expect(after?.bio).toBeUndefined();
    expect(after?.image).toBeUndefined();
  });

  it('skips an artist that does not exist', async () => {
    const result = await enrichArtistProfile(new mongoose.Types.ObjectId().toString());
    expect(result.status).toBe('skipped');
    expect(requestedUrls).toEqual([]);
  });

  it('reports nothing-found when no Wikidata item claims the MBID', async () => {
    setEnrichmentFetchForTests(async () => ({ query: { search: [] } }));
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    expect(result.status).toBe('nothing-found');
    expect(result.fieldsWritten).toEqual([]);
  });
});

describe('enrichArtistProfile — filling gaps', () => {
  it('fills the empty fields of a contributed stub', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    expect(result.status).toBe('enriched');
    const after = await ArtistModel.findById(artist._id);
    expect(after?.bio).toBe('English pop rock band (1960–1970)');
    expect(after?.country).toBe('United Kingdom');
    expect(after?.links?.website).toBe('https://thebeatles.com');
    expect(result.fieldsWritten).toContain('bio');
    expect(result.fieldsWritten).toContain('country');
  });

  it('NEVER overwrites a value that is already there', async () => {
    // A claiming artist's own words outrank Wikidata's permanently.
    const artist = await seedArtist({
      bio: 'Words the artist wrote themselves.',
      country: 'Spain',
      links: { website: 'https://my-own-site.example' },
    });
    await enrichArtistProfile(artist._id.toString());

    const after = await ArtistModel.findById(artist._id);
    expect(after?.bio).toBe('Words the artist wrote themselves.');
    expect(after?.country).toBe('Spain');
    expect(after?.links?.website).toBe('https://my-own-site.example');
  });

  /**
   * Idempotency, asserted as a PROPERTY rather than as a status label.
   *
   * The second run may legitimately answer `nothing-found` (the sources had
   * nothing left to give) or `skipped` (a field it wanted to write is not
   * declared on the Mongoose schema, so the write would be discarded). What must
   * hold either way is that it writes no fields and adds no provenance entry —
   * asserting the exact string would make this test fail on a correct behaviour
   * change and, worse, pass while `sources[]` grew on every background pass.
   */
  it('is idempotent — a second run writes nothing and adds no provenance', async () => {
    const artist = await seedArtist();
    const first = await enrichArtistProfile(artist._id.toString());
    const second = await enrichArtistProfile(artist._id.toString());

    expect(first.status).toBe('enriched');
    expect(second.status).not.toBe('enriched');
    expect(second.fieldsWritten).toEqual([]);

    const after = await ArtistModel.findById(artist._id);
    // ONE entry, not two. Enrichment is a background job that may be re-queued
    // after a failure and scheduled over the whole catalogue; an entry per run
    // is an audit log that grows without bound and explains nothing.
    expect(after?.sources).toHaveLength(1);
  });

  /**
   * The smoke alarm for a field that exists in the zod type and not in the
   * Mongoose schema. Mongoose discards such a `$set` silently, so without this
   * the function would report success, log the field list, and persist nothing.
   */
  it('never records provenance for a field that did not actually persist', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    const after = await ArtistModel.findById(artist._id);
    const recorded = after?.sources?.[0]?.fields ?? [];
    const stored = after?.toObject() as Record<string, unknown> | undefined;

    for (const field of recorded) {
      const value = field
        .split('.')
        .reduce<unknown>(
          (current, segment) =>
            typeof current === 'object' && current !== null
              ? (current as Record<string, unknown>)[segment]
              : undefined,
          stored,
        );
      expect(value).toBeDefined();
    }
    expect(recorded).toEqual(result.fieldsWritten);
  });

  it('records every imported field in sources[] with provider and date', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    const after = await ArtistModel.findById(artist._id);
    const entry = after?.sources?.[0];
    if (!entry) throw new Error('expected a provenance entry');

    // This is what lets a claiming artist see what came from outside and replace
    // all of it — without it the enrichment is unattributable and unrevertable.
    expect(entry.provider).toBe('wikidata');
    expect(entry.externalId).toBe('Q1299');
    expect(new Date(entry.importedAt).toISOString()).toBe(entry.importedAt);
    expect([...entry.fields].sort()).toEqual([...result.fieldsWritten].sort());
  });
});

describe('enrichArtistProfile — the photograph', () => {
  it('stores the Commons photo WITH its licence and attribution', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    expect(result.imageWritten).toBe(true);
    const after = await ArtistModel.findById(artist._id);
    expect(after?.image).toMatch(/^[a-f\d]{24}$/i);
    expect(after?.imageSizes?.large?.url).toBeDefined();

    // The licence travels WITH the image, because that is what CC BY-SA actually
    // requires — attribution held somewhere nobody renders discharges nothing.
    expect(after?.imageLicence?.licence).toBe('Public domain');
    expect(after?.imageLicence?.attribution).toBe('Bo Trenter');
    expect(after?.imageLicence?.sourceUrl).toBe(
      'https://commons.wikimedia.org/wiki/File:Beatles_Trenter_1963.jpg',
    );
  });

  it('does not touch an artist that already has a photo', async () => {
    const existing = new mongoose.Types.ObjectId().toString();
    const artist = await seedArtist({ image: existing });
    const result = await enrichArtistProfile(artist._id.toString());

    expect(result.imageWritten).toBe(false);
    const after = await ArtistModel.findById(artist._id);
    expect(after?.image).toBe(existing);
    expect(after?.imageLicence).toBeUndefined();
    // The download is the expensive part of this job, so a profile that already
    // has a photo must not pay for one.
    expect(requestedUrls.some((url) => url.includes('commons.wikimedia.org'))).toBe(false);
  });

  it('stores NO image when Commons cannot supply a licence', async () => {
    setEnrichmentFetchForTests(async (url) => {
      if (url.includes('commons.wikimedia.org')) {
        return {
          query: {
            pages: {
              '1': {
                imageinfo: [
                  {
                    url: 'https://upload.wikimedia.org/x.jpg',
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
                    extmetadata: { Artist: { value: 'Someone' } },
                  },
                ],
              },
            },
          },
        };
      }
      return routeToPayload(url);
    });

    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist._id.toString());

    // The rest of the profile is still enriched; only the image is refused.
    expect(result.status).toBe('enriched');
    expect(result.imageWritten).toBe(false);
    const after = await ArtistModel.findById(artist._id);
    expect(after?.image).toBeUndefined();
    expect(after?.imageLicence).toBeUndefined();
    expect(after?.bio).toBeDefined();
  });
});

describe('artist photo suggestions from an uploaded file', () => {
  /**
   * A real JPEG, produced by the fixture generator, so `sharp` reads genuine
   * dimensions rather than a hand-written buffer that would fail to probe.
   */
  async function fixturePicture(type: string): Promise<ExtractedPicture> {
    const extracted = await extractMetadata(
      path.join(__dirname, '__fixtures__', 'indie-id3v2.mp3'),
    );
    const source = extracted.pictures[0];
    return { ...source, type };
  }

  /**
   * The image service is injected rather than module-mocked: `mock.module` is
   * process-GLOBAL in bun and would replace the image service for every other
   * test file in the run.
   */
  const fakeStore: ArtistPhotoSuggestionDeps = {
    storeImage: async () => ({ id: new mongoose.Types.ObjectId().toString(), s3Key: 'k' }),
  };

  it('classifies picture types, which is what keeps a cover off an artist profile', () => {
    expect(isArtistPicture('Artist/performer')).toBe(true);
    expect(isArtistPicture('Lead artist/lead performer/soloist')).toBe(true);
    expect(isArtistPicture('Band/Orchestra')).toBe(true);

    expect(isArtistPicture('Cover (front)')).toBe(false);
    expect(isArtistPicture('Cover (back)')).toBe(false);
    expect(isArtistPicture('Media (e.g. label side of CD)')).toBe(false);
    // M4A's `covr` atom carries no type at all, so a picture from one can never
    // be assumed to be of the artist.
    expect(isArtistPicture(undefined)).toBe(false);
  });

  it('stores an artist-type picture as a SUGGESTION, never as the profile photo', async () => {
    const artist = await seedArtist();
    const stored = await suggestArtistPhotosFromUpload({
      artistId: artist._id.toString(),
      pictures: [await fixturePicture('Artist/performer')],
      proposedByOxyUserId: 'oxy-uploader',
      sourceUploadId: new mongoose.Types.ObjectId().toString(),
    }, fakeStore);

    expect(stored).toBe(1);
    // `imageSuggestions` is `select: false`, so it has to be asked for — which is
    // the enforcement that keeps it out of every ordinary profile read.
    const after = await ArtistModel.findById(artist._id).select('+imageSuggestions');
    expect(after?.imageSuggestions).toHaveLength(1);
    const suggestion = after?.imageSuggestions?.[0];
    expect(suggestion?.image.origin).toBe('upload');
    expect(suggestion?.proposedByOxyUserId).toBe('oxy-uploader');

    // The profile photo itself is untouched: publishing a picture out of a
    // stranger's MP3 site-wide is a different act from showing a disc's cover.
    expect(after?.image).toBeUndefined();
  });

  it('ignores cover art — that is the release, not the artist', async () => {
    const artist = await seedArtist();
    const stored = await suggestArtistPhotosFromUpload({
      artistId: artist._id.toString(),
      pictures: [
        await fixturePicture('Cover (front)'),
        await fixturePicture('Cover (back)'),
        await fixturePicture('Media (e.g. label side of CD)'),
      ],
    }, fakeStore);

    expect(stored).toBe(0);
    const after = await ArtistModel.findById(artist._id).select('+imageSuggestions');
    expect(after?.imageSuggestions ?? []).toHaveLength(0);
  });

  it('stores nothing for a file with no pictures at all', async () => {
    const artist = await seedArtist();
    expect(
      await suggestArtistPhotosFromUpload(
        { artistId: artist._id.toString(), pictures: [] },
        fakeStore,
      ),
    ).toBe(0);
  });

  it('survives a malformed picture frame rather than failing the upload', async () => {
    const artist = await seedArtist();
    const stored = await suggestArtistPhotosFromUpload({
      artistId: artist._id.toString(),
      pictures: [
        { type: 'Artist/performer', mimeType: 'image/jpeg', data: Buffer.from('not an image') },
      ],
    }, fakeStore);
    // The audio is what the listener uploaded; a broken APIC frame must not cost
    // them the upload.
    expect(stored).toBe(0);
  });
});

describe('cover art recovery — the blocker it clears', () => {
  it('recovers a front cover for a release', async () => {
    const recovered = await recoverCoverArt({ releaseMbid: RELEASE_MBID, externalId: RELEASE_MBID });
    if (!recovered) throw new Error('expected cover art');

    expect(recovered.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(recovered.licence.attribution).toBe('Cover Art Archive');
    expect(recovered.licence.sourceUrl).toContain('musicbrainz.org/release/');
  });

  it('returns nothing when the archive has none, rather than a placeholder', async () => {
    setEnrichmentFetchForTests(async () => undefined);
    expect(await recoverCoverArt({ releaseMbid: RELEASE_MBID, externalId: 'x' })).toBeUndefined();
  });

  /**
   * The blocker in the plan, end to end. `Album.coverArt` is REQUIRED, so before
   * this a Picard-tagged file with no embedded artwork could never produce an
   * album and its tracks stayed loose under the artist forever.
   */
  it('lets ensureContributedAlbum create an album for a file with NO embedded art', async () => {
    const album = await ensureContributedAlbum({
      title: 'Abbey Road',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      musicbrainzReleaseId: RELEASE_MBID,
      // coverArt deliberately absent — this is the case that used to fail.
    });

    if (!album) throw new Error('expected an album');
    expect(album.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(album.sources?.[0]?.provider).toBe('cover-art-archive');
    expect(album.sources?.[0]?.fields).toEqual(['coverArt']);
  });

  it('still declines when there is no embedded art AND the archive has none', async () => {
    setEnrichmentFetchForTests(async () => undefined);
    const album = await ensureContributedAlbum({
      title: 'Nowhere Album',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'Nobody',
      releaseDate: '2024-01-01',
      musicbrainzReleaseId: RELEASE_MBID,
    });

    // Loose tracks under the artist is the correct outcome. A generated
    // placeholder becomes the release's real cover the moment it is written.
    expect(album).toBeNull();
    expect(await AlbumModel.countDocuments()).toBe(0);
  });

  it('prefers the embedded cover the caller supplies over the archive', async () => {
    const embedded = new mongoose.Types.ObjectId().toString();
    const album = await ensureContributedAlbum({
      title: 'Abbey Road',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      coverArt: embedded,
      musicbrainzReleaseId: RELEASE_MBID,
    });

    expect(album?.coverArt).toBe(embedded);
    expect(requestedUrls.some((url) => url.includes('coverartarchive.org'))).toBe(false);
  });

  it('repairs an existing album that has no cover art', async () => {
    const album = await AlbumModel.create({
      title: 'Abbey Road',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      coverArt: 'placeholder-to-be-cleared',
      source: 'upload',
      externalIds: { musicbrainzReleaseId: RELEASE_MBID },
    });
    await AlbumModel.updateOne({ _id: album._id }, { $unset: { coverArt: 1 } });

    const result = await enrichAlbumCoverArt(album._id.toString());
    expect(result.status).toBe('enriched');

    const after = await AlbumModel.findById(album._id);
    expect(after?.coverArt).toMatch(/^[a-f\d]{24}$/i);
    expect(after?.sources?.[0]?.provider).toBe('cover-art-archive');
  });

  it('leaves an album that already has art alone', async () => {
    const existing = new mongoose.Types.ObjectId().toString();
    const album = await AlbumModel.create({
      title: 'Abbey Road',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      coverArt: existing,
      source: 'upload',
      externalIds: { musicbrainzReleaseId: RELEASE_MBID },
    });

    const result = await enrichAlbumCoverArt(album._id.toString());
    expect(result.status).toBe('skipped');
    expect((await AlbumModel.findById(album._id))?.coverArt).toBe(existing);
  });

  it('skips an album with no release id to look art up by', async () => {
    const album = await AlbumModel.create({
      title: 'Untagged',
      artistId: new mongoose.Types.ObjectId().toString(),
      artistName: 'Nobody',
      releaseDate: '2024-01-01',
      coverArt: 'x',
      source: 'upload',
    });
    await AlbumModel.updateOne({ _id: album._id }, { $unset: { coverArt: 1 } });

    const result = await enrichAlbumCoverArt(album._id.toString());
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('MusicBrainz release id');
  });
});
