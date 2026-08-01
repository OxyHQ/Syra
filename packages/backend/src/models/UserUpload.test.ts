import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../test/mongo';
import { buildAlbumKey } from '@syra/shared-types';
import { UserUploadModel } from './UserUpload';

beforeAll(connect);

/**
 * Build the indexes before EVERY test.
 *
 * Mongoose's background `autoIndex` otherwise races the first insert, and a
 * uniqueness assertion that races its own index passes on timing rather than on
 * the constraint. Per test rather than once, because the whole suite shares one
 * mongod and other files drop collections; `createIndexes()` is idempotent, so
 * the rebuild is a no-op the rest of the time.
 */
beforeEach(async () => {
  await UserUploadModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

/** The minimum a locker row needs; each test overrides only what it is about. */
function upload(overrides: Record<string, unknown> = {}) {
  return {
    ownerOxyUserId: 'oxy-1',
    title: 'Some Recording',
    artistName: 'Some Artist',
    duration: 210,
    sizeBytes: 5_242_880,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

describe('UserUpload', () => {
  it('rejects the same bytes twice for one owner', async () => {
    await UserUploadModel.create(upload());

    await expect(
      UserUploadModel.create(upload({ title: 'Renamed, same file' })),
    ).rejects.toThrow();
  });

  it('lets two DIFFERENT owners each keep the same file', async () => {
    await UserUploadModel.create(upload());
    await UserUploadModel.create(upload({ ownerOxyUserId: 'oxy-2' }));

    // The constraint is per owner: a locker is one person's storage, so the same
    // recording in two lockers is two independent copies, not a duplicate.
    expect(await UserUploadModel.countDocuments({ sha256: 'a'.repeat(64) })).toBe(2);
  });

  it('accepts an upload with no artistName', async () => {
    // A file with no artist tag is a valid PRIVATE upload — the locker exists for
    // exactly the uncatalogued material that carries no metadata. (The public
    // contribution path is where an artist is mandatory.)
    const saved = await UserUploadModel.create(upload({ artistName: undefined }));

    expect(saved.artistName).toBeUndefined();
    expect(saved.title).toBe('Some Recording');
    expect(saved.status).toBe('processing');
    expect(saved.playCount).toBe(0);
  });

  it('does NOT carry a TTL index on expiresAt', async () => {
    const indexes = await UserUploadModel.collection.indexes();

    const expiresIndex = indexes.find((index) => index.key?.expiresAt === 1);
    expect(expiresIndex).toBeDefined();
    // A TTL index would delete documents without running application code,
    // orphaning every S3 object behind them and skipping the T-14d warning. The
    // sweeper reads this index and deletes storage and document together.
    expect(expiresIndex?.expireAfterSeconds).toBeUndefined();
  });
});

describe('UserUpload rawTags', () => {
  const rawTags = {
    format: 'ID3v2.4',
    json: JSON.stringify({ TPE1: 'Some Artist', 'TXXX:Acoustid Id': 'abc' }),
    truncated: false,
    originalByteLength: 61,
  };


    /**
     * COVERAGE BOUNDARY, stated because the old name overpromised it.
     *
     * `select: false` is a QUERY PROJECTION. `aggregate()` ignores it entirely
     * and returns the whole document, so this proves the `find`/`findOne` path
     * ONLY. Any aggregation pipeline that reads this collection must exclude the
     * field explicitly with `$project`, and any serializer funnel must strip it.
     * Treat `select: false` as a bytes-on-the-wire optimisation, never as access
     * control.
     */
  it('is NOT returned by find()/findOne() — see the note on aggregate()', async () => {
    const created = await UserUploadModel.create(upload({ rawTags }));

    // `select: false` is the enforcement, not a convention. A serializer that
    // spreads a document cannot leak a field the document never contained, so
    // this is what stops the raw tag dump reaching a client.
    const found = await UserUploadModel.findById(created._id).lean();
    expect(found).not.toBeNull();
    expect(found?.rawTags).toBeUndefined();
    expect(Object.keys(found ?? {})).not.toContain('rawTags');

    const listed = await UserUploadModel.find({ ownerOxyUserId: 'oxy-1' }).lean();
    expect(listed[0]?.rawTags).toBeUndefined();
  });

  it('IS stored, and readable when a caller explicitly asks', async () => {
    // The vacuity floor for the test above: if the field were never persisted at
    // all, "not returned" would pass for the wrong reason.
    const created = await UserUploadModel.create(upload({ rawTags }));

    const withTags = await UserUploadModel.findById(created._id).select('+rawTags').lean();
    expect(withTags?.rawTags?.json).toBe(rawTags.json);
    expect(withTags?.rawTags?.format).toBe('ID3v2.4');
    expect(withTags?.rawTags?.truncated).toBe(false);
  });
});

describe('UserUpload album grouping', () => {
  it('groups a folder of files under ONE albumKey, no Album row created', async () => {
    const albumKey = buildAlbumKey({
      albumArtistName: 'Radiohead',
      albumName: 'Kid A',
      year: 2000,
    });

    for (const [index, title] of ['Everything In Its Right Place', 'Kid A', 'The National Anthem'].entries()) {
      await UserUploadModel.create(
        upload({
          title,
          sha256: String(index).repeat(64).slice(0, 64),
          albumArtistName: 'Radiohead',
          albumName: 'Kid A',
          year: 2000,
          albumKey,
          trackNumber: index + 1,
          discNumber: 1,
          totalTracks: 10,
        }),
      );
    }

    // The locker's album page IS this aggregation — there is no per-user Album
    // collection, deliberately: a private file must not create a catalog row.
    const grouped = await UserUploadModel.find({ ownerOxyUserId: 'oxy-1', albumKey })
      .sort({ discNumber: 1, trackNumber: 1 })
      .lean();

    expect(grouped).toHaveLength(3);
    expect(grouped.map((doc) => doc.trackNumber)).toEqual([1, 2, 3]);
    // From the tag's `1/10`, not from counting the three files uploaded.
    expect(grouped[0]?.totalTracks).toBe(10);
  });
});

describe('UserUpload captured metadata', () => {
  it('persists credits, replay gain, lyrics and edition facts', async () => {
    const saved = await UserUploadModel.create(
      upload({
        credits: [
          { name: 'Nigel Godrich', role: 'producer', nameKey: 'nigel godrich' },
          { name: 'Thom Yorke', role: 'composer', nameKey: 'thom yorke', catalogEntityId: 'entity-1' },
        ],
        replayGain: { trackDb: -7.5, albumDb: -8.1, trackPeak: 0.98 },
        lyrics: { synced: true, lines: [{ timeMs: 0, text: 'Everything' }], plain: 'Everything', language: 'eng' },
        totalTracks: 10,
        totalDiscs: 1,
        originalReleaseDate: '2000',
        catalogNumber: 'PARLOPHONE-7243',
        label: 'Parlophone',
        media: 'CD',
        releaseCountry: 'GB',
        comment: 'Ripped from CD',
      }),
    );

    expect(saved.credits).toHaveLength(2);
    expect(saved.credits?.[1]?.catalogEntityId).toBe('entity-1');
    // A medium-confidence credit stays displayable text and links nowhere.
    expect(saved.credits?.[0]?.catalogEntityId).toBeUndefined();
    expect(saved.replayGain?.trackDb).toBe(-7.5);
    expect(saved.lyrics?.lines?.[0]?.text).toBe('Everything');
    // A bare year survives as written; coercing it to a Date would invent a
    // precision the file never claimed.
    expect(saved.originalReleaseDate).toBe('2000');
    expect(saved.label).toBe('Parlophone');
    expect(saved.media).toBe('CD');
  });
});
