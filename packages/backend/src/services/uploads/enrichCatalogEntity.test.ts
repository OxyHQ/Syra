import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import {
  installCatalogImageMirrorMockForTests,
  resetCatalogImageMirror,
} from '../../test/catalogImageMirror';
import { getDb } from '../../db/postgres';
import {
  albumSources,
  albums,
  catalogEntities,
  catalogEntitySources,
  imageAssets,
} from '../../db/schema/catalog';
import { setEnrichmentFetchForTests } from './enrichmentHttp';
import {
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

beforeAll(connectDb);
beforeEach(() => {
  // Installed HERE rather than as a side effect of a database connect, which is
  // how it silently went missing when this suite moved to Postgres.
  installCatalogImageMirrorMockForTests();
  requestedUrls = [];
  setEnrichmentFetchForTests(async (url) => {
    requestedUrls.push(url);
    return routeToPayload(url);
  });
});
afterEach(async () => {
  setEnrichmentFetchForTests();
  resetCatalogImageMirror();
  await clearDb();
});
afterAll(disconnectDb);

/** A real `image_assets` row — the six variant columns are foreign keys. */
async function makeImageAsset(): Promise<string> {
  const id = uuidv7();
  await getDb().insert(imageAssets).values({
    id,
    s3Key: `fixtures/${id}.jpg`,
    filename: `${id}.jpg`,
    contentType: 'image/jpeg',
    byteSize: 1,
    width: 640,
    height: 640,
    ownerType: 'artist',
  });
  return id;
}

/** A real artist row, because `albums.artist_id` is a foreign key now. */
async function makeArtistRow(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Album Artist ${suffix}`,
      nameKey: `album-artist-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('makeArtistRow: insert returned no row');
  return artist.id;
}

async function readArtist(id: string) {
  const [artist] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);
  return artist;
}

/** Provenance is a child table now, ordered by `position`. */
async function sourcesFor(catalogEntityId: string) {
  return getDb()
    .select()
    .from(catalogEntitySources)
    .where(eq(catalogEntitySources.catalogEntityId, catalogEntityId));
}

async function albumCount(): Promise<number> {
  const [row] = await getDb().select({ total: count() }).from(albums);
  return row?.total ?? 0;
}

async function seedArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<{ id: string }> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'The Beatles',
      nameKey: `the-beatles-${suffix}`,
      source: 'upload',
      origin: 'contributed',
      claimable: true,
      externalMusicbrainzArtistId: BEATLES_MBID,
      ...overrides,
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedArtist: insert returned no row');
  return artist;
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
    const artist = await seedArtist({ name: 'Nirvana', externalMusicbrainzArtistId: null });
    const result = await enrichArtistProfile(artist.id);

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('MusicBrainz');
    expect(result.fieldsWritten).toEqual([]);
    expect(requestedUrls).toEqual([]);

    const after = await readArtist(artist.id);
    expect(after?.bio).toBeNull();
    expect(after?.imageId).toBeNull();
  });

  it('skips an artist that does not exist', async () => {
    const result = await enrichArtistProfile(await makeArtistRow());
    expect(result.status).toBe('skipped');
    expect(requestedUrls).toEqual([]);
  });

  it('reports nothing-found when no Wikidata item claims the MBID', async () => {
    setEnrichmentFetchForTests(async () => ({ query: { search: [] } }));
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist.id);

    expect(result.status).toBe('nothing-found');
    expect(result.fieldsWritten).toEqual([]);
  });
});

describe('enrichArtistProfile — filling gaps', () => {
  it('fills the empty fields of a contributed stub', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist.id);

    expect(result.status).toBe('enriched');
    const after = await readArtist(artist.id);
    expect(after?.bio).toBe('English pop rock band (1960–1970)');
    expect(after?.country).toBe('United Kingdom');
    expect(after?.linksWebsite).toBe('https://thebeatles.com');
    expect(result.fieldsWritten).toContain('bio');
    expect(result.fieldsWritten).toContain('country');
  });

  it('NEVER overwrites a value that is already there', async () => {
    // A claiming artist's own words outrank Wikidata's permanently.
    const artist = await seedArtist({
      bio: 'Words the artist wrote themselves.',
      country: 'Spain',
      linksWebsite: 'https://my-own-site.example',
    });
    await enrichArtistProfile(artist.id);

    const after = await readArtist(artist.id);
    expect(after?.bio).toBe('Words the artist wrote themselves.');
    expect(after?.country).toBe('Spain');
    expect(after?.linksWebsite).toBe('https://my-own-site.example');
  });

  /**
   * Idempotency, asserted as a PROPERTY rather than as a status label.
   *
   * The second run answers `nothing-found` — the sources had nothing left to
   * give. (It could once also answer `skipped`, for a field the Mongoose schema
   * did not declare; that arm is gone with the database that needed it.) What
   * must hold is that it writes no fields and adds no provenance ROW —
   * asserting the exact status string would make this fail on a correct
   * behaviour change and, worse, pass while `catalog_entity_sources` grew on
   * every background pass.
   */
  it('is idempotent — a second run writes nothing and adds no provenance', async () => {
    const artist = await seedArtist();
    const first = await enrichArtistProfile(artist.id);
    const second = await enrichArtistProfile(artist.id);

    expect(first.status).toBe('enriched');
    expect(second.status).not.toBe('enriched');
    expect(second.fieldsWritten).toEqual([]);

    const after = await readArtist(artist.id);
    // ONE entry, not two. Enrichment is a background job that may be re-queued
    // after a failure and scheduled over the whole catalogue; an entry per run
    // is an audit log that grows without bound and explains nothing.
    expect(await sourcesFor(artist.id)).toHaveLength(1);
  });

  /**
   * A TEST WAS DELETED HERE, because the failure it guarded is unrepresentable.
   *
   * It re-read the artist after enrichment and asserted every field named in
   * `sources[].fields` had actually persisted — the smoke alarm for Mongoose
   * strict mode DISCARDING a `$set` on a path the schema does not declare,
   * silently. Left unchecked that meant a scheduled job appending a provenance
   * entry per run forever while storing nothing.
   *
   * With drizzle an unknown column key is a COMPILE error and an unknown column
   * in SQL is a runtime one, so a write that returns is a write that landed.
   * The service's verification read, `readPath`, and its "nothing persisted"
   * result arm were deleted with it — they were compensating for a database
   * behaviour this one does not have, and a test asserting the compensation
   * would now be asserting nothing.
   *
   * The idempotency test above is the one that still earns its place: it is a
   * property (`second run writes nothing, provenance stays at one entry`)
   * rather than an assertion about a mechanism.
   */

  it('records every imported field in sources[] with provider and date', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist.id);

    const [entry] = await sourcesFor(artist.id);
    if (!entry) throw new Error('expected a provenance entry');

    // This is what lets a claiming artist see what came from outside and replace
    // all of it — without it the enrichment is unattributable and unrevertable.
    expect(entry.provider).toBe('wikidata');
    expect(entry.externalId).toBe('Q1299');
    // `imported_at` is a real `timestamptz` now, not an ISO string in a
    // subdocument, so the assertion is that it IS an instant rather than that
    // it round-trips as text.
    expect(entry.importedAt).toBeInstanceOf(Date);
    expect([...entry.fields].sort()).toEqual([...result.fieldsWritten].sort());
  });
});

describe('enrichArtistProfile — the photograph', () => {
  it('stores the Commons photo WITH its licence and attribution', async () => {
    const artist = await seedArtist();
    const result = await enrichArtistProfile(artist.id);

    expect(result.imageWritten).toBe(true);
    const after = await readArtist(artist.id);
    // Each variant is its own FK column now, not a nested `imageSizes` object.
    expect(after?.imageId).toBeTruthy();
    expect(after?.imageSizesLargeId).toBeTruthy();

    // The licence travels WITH the image, because that is what CC BY-SA actually
    // requires — attribution held somewhere nobody renders discharges nothing.
    expect(after?.imageLicenceLicence).toBe('Public domain');
    expect(after?.imageLicenceAttribution).toBe('Bo Trenter');
    expect(after?.imageLicenceSourceUrl).toBe(
      'https://commons.wikimedia.org/wiki/File:Beatles_Trenter_1963.jpg',
    );
  });

  it('does not touch an artist that already has a photo', async () => {
    // A real `image_assets` row: `catalog_entities.image_id` is a foreign key,
    // so a minted id is a constraint violation rather than a harmless fake.
    const existing = await makeImageAsset();
    const artist = await seedArtist({ imageId: existing });
    const result = await enrichArtistProfile(artist.id);

    expect(result.imageWritten).toBe(false);
    const after = await readArtist(artist.id);
    expect(after?.imageId).toBe(existing);
    expect(after?.imageLicenceLicence).toBeNull();
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
    const result = await enrichArtistProfile(artist.id);

    // The rest of the profile is still enriched; only the image is refused.
    expect(result.status).toBe('enriched');
    expect(result.imageWritten).toBe(false);
    const after = await readArtist(artist.id);
    expect(after?.imageId).toBeNull();
    expect(after?.imageLicenceLicence).toBeNull();
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
    storeImage: async () => ({ id: await makeArtistRow(), s3Key: 'k' }),
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
      artistId: artist.id,
      pictures: [await fixturePicture('Artist/performer')],
      proposedByOxyUserId: 'oxy-uploader',
      sourceUploadId: uuidv7(),
    }, fakeStore);

    expect(stored).toBe(1);
    /**
     * `imageSuggestions` is asked for EXPLICITLY here, and the reason changed
     * with the database. Under Mongo it was `select: false`, which Task 10a
     * measured as no protection at all — `aggregate()` ignores it. What keeps it
     * off the wire now is `PROTECTED_COLUMNS_BY_TABLE`: it is absent from
     * `PublicCatalogEntityRow`, so a serializer cannot even NAME it. A test
     * still has to read it directly, and this is the read.
     */
    const after = await readArtist(artist.id);
    expect(after?.imageSuggestions).toHaveLength(1);
    const suggestion = after?.imageSuggestions?.[0];
    expect(suggestion?.image.origin).toBe('upload');
    expect(suggestion?.proposedByOxyUserId).toBe('oxy-uploader');

    // The profile photo itself is untouched: publishing a picture out of a
    // stranger's MP3 site-wide is a different act from showing a disc's cover.
    expect(after?.imageId).toBeNull();
  });

  it('ignores cover art — that is the release, not the artist', async () => {
    const artist = await seedArtist();
    const stored = await suggestArtistPhotosFromUpload({
      artistId: artist.id,
      pictures: [
        await fixturePicture('Cover (front)'),
        await fixturePicture('Cover (back)'),
        await fixturePicture('Media (e.g. label side of CD)'),
      ],
    }, fakeStore);

    expect(stored).toBe(0);
    const after = await readArtist(artist.id);
    expect(after?.imageSuggestions ?? []).toHaveLength(0);
  });

  it('stores nothing for a file with no pictures at all', async () => {
    const artist = await seedArtist();
    expect(
      await suggestArtistPhotosFromUpload(
        { artistId: artist.id, pictures: [] },
        fakeStore,
      ),
    ).toBe(0);
  });

  it('survives a malformed picture frame rather than failing the upload', async () => {
    const artist = await seedArtist();
    const stored = await suggestArtistPhotosFromUpload({
      artistId: artist.id,
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

    // An `image_assets` id — a uuid v7 for anything minted since the cutover,
    // a 24-char ObjectId hex for a row carried over from Mongo. Asserting the
    // ObjectId shape, as this did, would fail for every image created from now
    // on; `isLiveEntityId` is the predicate that accepts both, and it is the
    // same one `normalizeImageRef` uses to decide the served URL.
    expect(isLiveEntityId(recovered.coverArt)).toBe(true);
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
      artistId: await makeArtistRow(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      musicbrainzReleaseId: RELEASE_MBID,
      // coverArt deliberately absent — this is the case that used to fail.
    });

    if (!album) throw new Error('expected an album');

    // `ensureContributedAlbum` returns an identity, not the row, so the cover
    // and its provenance are read back from the columns and the child table.
    const [stored] = await getDb().select().from(albums).where(eq(albums.id, album.id)).limit(1);
    expect(stored?.coverArtId).toBeTruthy();

    const [provenance] = await getDb()
      .select()
      .from(albumSources)
      .where(eq(albumSources.albumId, album.id));
    expect(provenance?.provider).toBe('cover-art-archive');
    expect(provenance?.fields).toEqual(['coverArt']);
  });

  it('still declines when there is no embedded art AND the archive has none', async () => {
    setEnrichmentFetchForTests(async () => undefined);
    const album = await ensureContributedAlbum({
      title: 'Nowhere Album',
      artistId: await makeArtistRow(),
      artistName: 'Nobody',
      releaseDate: '2024-01-01',
      musicbrainzReleaseId: RELEASE_MBID,
    });

    // Loose tracks under the artist is the correct outcome. A generated
    // placeholder becomes the release's real cover the moment it is written.
    expect(album).toBeNull();
    expect(await albumCount()).toBe(0);
  });

  it('prefers the embedded cover the caller supplies over the archive', async () => {
    // A real `image_assets` row: `albums.cover_art_id` is a NOT NULL FK.
    const embedded = await makeImageAsset();
    const album = await ensureContributedAlbum({
      title: 'Abbey Road',
      artistId: await makeArtistRow(),
      artistName: 'The Beatles',
      releaseDate: '1969-09-26',
      coverArt: embedded,
      musicbrainzReleaseId: RELEASE_MBID,
    });

    const [stored] = await getDb()
      .select({ coverArtId: albums.coverArtId })
      .from(albums)
      .where(eq(albums.id, album?.id ?? ''))
      .limit(1);
    expect(stored?.coverArtId).toBe(embedded);
    expect(requestedUrls.some((url) => url.includes('coverartarchive.org'))).toBe(false);
  });

  /**
   * THREE TESTS WERE DELETED HERE with `enrichAlbumCoverArt` itself.
   *
   * It repaired "an existing album's missing cover art" — a state that cannot
   * exist: `albums.cover_art_id` is NOT NULL, and `models/Album.ts:69` declared
   * `coverArt: { type: String, required: true }` for the same reason, so the
   * function was already dead under Mongo too. Its guard
   * (`if (album.coverArt) return skipped`) was unconditionally true, and it had
   * no production caller anywhere in the repo.
   *
   * These tests reached its working arm only by `$unset`-ing `coverArt` AFTER
   * creation — i.e. by building a document Mongoose would have refused to save.
   * Under a NOT NULL column that fixture is unrepresentable, so there is nothing
   * left to test and nothing left to test it against.
   *
   * `recoverCoverArt` is the live half of the pair — it runs BEFORE an album
   * exists and decides whether the container can be created at all — and it is
   * covered by the three tests above.
   */
});