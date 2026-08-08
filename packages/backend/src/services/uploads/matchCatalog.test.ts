import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, trackFingerprints, tracks } from '../../db/schema/catalog';
import { userUploads } from '../../db/schema/creators';
import { matchCatalog, normalizeForFuzzy, type MatchCandidate } from './matchCatalog';
import corpus from './__fixtures__/fingerprints.json';

/**
 * ONE database. Tiers 1-4 read the catalogue and tier 1's OTHER half — "is this
 * already in the uploader's own locker" — reads `user_uploads`, which was Task
 * 13's still-Mongoose vertical when this suite was written and is Postgres now.
 */
beforeAll(connectDb);
beforeEach(async () => {
  // `tracks.artist_id` is a real foreign key, so the artist has to exist
  // before any track fixture does — and it is re-made per test because
  // `clearDb` truncates.
  ARTIST_ID = await seedArtist();
});
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-user-uploader';
const OTHER_OWNER = 'oxy-user-someone-else';
let ARTIST_ID = '';

async function seedArtist(): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: 'Nadia Ortiz',
      nameKey: `nadia-ortiz-${suffix}`,
      source: 'upload',
    })
    .returning({ id: catalogEntities.id });
  if (!artist) throw new Error('seedArtist: insert returned no row');
  return artist.id;
}

const SHA_OF_UPLOAD = 'a'.repeat(64);

async function seedTrack(
  overrides: Partial<typeof tracks.$inferInsert> = {}
): Promise<{ id: string }> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title: 'Midnight Ferry',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
      duration: 180,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      ...overrides,
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('seedTrack: insert returned no row');
  return track;
}

async function seedFingerprint(trackId: string, values: number[], durationSec: number): Promise<void> {
  await getDb().insert(trackFingerprints).values({
    trackId,
    fingerprint: values,
    fingerprintDurationSec: durationSec,
  });
}

async function setTrack(trackId: string, patch: Partial<typeof tracks.$inferInsert>): Promise<void> {
  await getDb().update(tracks).set(patch).where(eq(tracks.id, trackId));
}

async function seedUpload(
  overrides: Partial<typeof userUploads.$inferInsert> = {}
): Promise<{ id: string }> {
  const [upload] = await getDb()
    .insert(userUploads)
    .values({
      ownerOxyUserId: OWNER,
      title: 'Midnight Ferry',
      duration: 180,
      sha256: SHA_OF_UPLOAD,
      sizeBytes: 4096,
      audioSourceKey: 'locker/x.mp3',
      audioSourceFormat: 'mp3',
      status: 'ready',
      ...overrides,
    })
    .returning({ id: userUploads.id });
  return upload;
}

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    sha256: SHA_OF_UPLOAD,
    durationSec: 180,
    title: 'Midnight Ferry',
    artistName: 'Nadia Ortiz',
    ...overrides,
  };
}

describe('matchCatalog — tier 1, identical bytes', () => {
  it('finds a catalog track with the same content hash', async () => {
    const track = await seedTrack({ sha256: SHA_OF_UPLOAD });
    const result = await matchCatalog(
      candidate({ title: undefined, artistName: undefined }),
      OWNER,
    );

    expect(result).toEqual({
      kind: 'track',
      trackId: track.id,
      tier: 'sha256',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
    });
  });

  it('does not match a hash-identical track that has been taken down', async () => {
    await seedTrack({ sha256: SHA_OF_UPLOAD, copyrightRemoved: true });
    const result = await matchCatalog(
      candidate({ title: undefined, artistName: undefined }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('the catalog hash wins over the locker copy of the same bytes', async () => {
    // Both hold these bytes. The catalog answer is the one that matters: the
    // upload is not stored again and the client adds the existing track.
    const track = await seedTrack({ sha256: SHA_OF_UPLOAD });
    await seedUpload();

    const result = await matchCatalog(candidate(), OWNER);
    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(track.id);
  });

  it("finds the uploader's own locker copy", async () => {
    const upload = await seedUpload();
    const result = await matchCatalog(candidate(), OWNER);

    expect(result).toEqual({
      kind: 'upload',
      uploadId: upload.id,
      tier: 'sha256',
    });
  });

  it("never matches somebody ELSE's locker", async () => {
    await seedUpload({ ownerOxyUserId: OTHER_OWNER });
    // Same bytes, different owner: matching would both leak that they hold the
    // file and hand this uploader an id they may not read.
    const result = await matchCatalog(candidate({ title: undefined, artistName: undefined }), OWNER);
    expect(result).toEqual({ kind: 'none' });
  });

  it('ignores a soft-deleted locker row', async () => {
    await seedUpload({ deletedAt: new Date() });
    const result = await matchCatalog(candidate({ title: undefined, artistName: undefined }), OWNER);
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('matchCatalog — tier 2, ISRC', () => {
  it('matches a catalog track by ISRC', async () => {
    const track = await seedTrack({ externalIsrc: 'ESA452300137' });
    const result = await matchCatalog(
      candidate({ isrc: 'ESA452300137', title: undefined, artistName: undefined }),
      OWNER,
    );

    expect(result).toEqual({
      kind: 'track',
      trackId: track.id,
      tier: 'isrc',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
    });
  });

  it('normalises the ISRC to upper case before comparing', async () => {
    await seedTrack({ externalIsrc: 'ESA452300137' });
    const result = await matchCatalog(candidate({ isrc: 'esa452300137' }), OWNER);
    expect(result.kind).toBe('track');
  });

  it('does not match a track that is not playable', async () => {
    // A takedown must not resolve to "this is already in the catalog, add it to
    // your library" — the listener would get a track they cannot play.
    await seedTrack({ externalIsrc: 'ESA452300137', copyrightRemoved: true });
    const result = await matchCatalog(
      candidate({ isrc: 'ESA452300137', title: undefined, artistName: undefined }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('matchCatalog — tier 3, fingerprint', () => {
  async function seedFingerprintedTrack(values: number[], durationSec: number) {
    const track = await seedTrack({ duration: durationSec, title: 'Some Other Title' });
    await seedFingerprint(track.id, values, durationSec);
    return track;
  }

  it('matches the same recording transcoded, with no ISRC and a different title', async () => {
    const track = await seedFingerprintedTrack(corpus.reference, 30);
    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: 'Completely Different Title',
        artistName: 'Someone Else',
        fingerprint: corpus.aac96,
      }),
      OWNER,
    );

    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(track.id);
    expect(result.tier).toBe('fingerprint');
    expect(result.bitErrorRate).toBeLessThan(0.01);
  });

  it('does not match a different recording of the same length', async () => {
    await seedFingerprintedTrack(corpus.closestNegativeA, 30);
    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.closestNegativeB,
      }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not consider candidates outside the duration bucket', async () => {
    await seedFingerprintedTrack(corpus.reference, 60);
    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.reference,
      }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('abstains when the upload has no fingerprint at all', async () => {
    // fpcalc unavailable. The tier must not silently report "no match".
    await seedFingerprintedTrack(corpus.reference, 30);
    const result = await matchCatalog(
      candidate({ sha256: 'b'.repeat(64), durationSec: 30, title: undefined, artistName: undefined }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });

  /**
   * A takedown must NOT dedup — handing a listener a track they cannot play is
   * worse than storing their upload — but the acoustic evidence must survive.
   * Discarding it is what let somebody re-upload a recording Syra removed for
   * copyright and receive a completely clean screening report.
   */
  it('declines to match a taken-down track but KEEPS the acoustic evidence', async () => {
    const track = await seedFingerprintedTrack(corpus.reference, 30);
    await setTrack(track.id, { copyrightRemoved: true });

    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.reference,
      }),
      OWNER,
    );

    expect(result.kind).toBe('none');
    if (result.kind !== 'none') throw new Error('unreachable');
    expect(result.nearestFingerprint?.trackId).toBe(track.id);
    expect(result.nearestFingerprint?.artistId).toBe(ARTIST_ID);
    expect(result.nearestFingerprint?.copyrightRemoved).toBe(true);
    expect(result.nearestFingerprint?.bitErrorRate).toBeLessThan(0.01);
  });

  it('keeps the evidence for an unavailable track too, but not as a takedown', async () => {
    // A creator unpublishing their own track is not a copyright judgement. The
    // neighbour still feeds artist resolution; it must not fire a blocking marker.
    const track = await seedFingerprintedTrack(corpus.reference, 30);
    await setTrack(track.id, { isAvailable: false });

    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.reference,
      }),
      OWNER,
    );

    expect(result.kind).toBe('none');
    if (result.kind !== 'none') throw new Error('unreachable');
    expect(result.nearestFingerprint?.trackId).toBe(track.id);
    expect(result.nearestFingerprint?.copyrightRemoved).toBe(false);
  });

  it('carries NO neighbour when a playable track matched — that is a dedup, not evidence', async () => {
    // The `none` arm is the only place the evidence is useful: a real dedup hit
    // stores no bytes, so screening and artist resolution never run.
    const track = await seedFingerprintedTrack(corpus.reference, 30);
    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.reference,
      }),
      OWNER,
    );
    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(track.id);
  });

  /**
   * A sub-threshold candidate is NOT reported. At BER 0.15 the two are different
   * recordings; passing that on as evidence would manufacture a provenance
   * marker out of noise, against uploads least able to argue with it.
   */
  it('reports no neighbour for a candidate that never crossed the match threshold', async () => {
    const track = await seedFingerprintedTrack(corpus.closestNegativeA, 30);
    await setTrack(track.id, { copyrightRemoved: true });

    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        title: undefined,
        artistName: undefined,
        fingerprint: corpus.closestNegativeB,
      }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('matchCatalog — tier 4, fuzzy', () => {
  it('matches on normalised title + artist within ±2 s', async () => {
    const track = await seedTrack({ duration: 181 });
    const result = await matchCatalog(
      candidate({ sha256: 'b'.repeat(64), title: 'MIDNIGHT FERRY', artistName: 'Nadia Ortíz' }),
      OWNER,
    );

    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(track.id);
    expect(result.tier).toBe('fuzzy');
  });

  it('does not match outside the ±2 s window', async () => {
    await seedTrack({ duration: 185 });
    const result = await matchCatalog(candidate({ sha256: 'b'.repeat(64) }), OWNER);
    expect(result).toEqual({ kind: 'none' });
  });

  it('does not run at all without both a title and an artist', async () => {
    await seedTrack();
    const result = await matchCatalog(
      candidate({ sha256: 'b'.repeat(64), artistName: undefined }),
      OWNER,
    );
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('matchCatalog — tier precedence', () => {
  it('the own-locker byte match wins over a catalog ISRC match', async () => {
    const upload = await seedUpload();
    await seedTrack({ externalIsrc: 'ESA452300137' });

    const result = await matchCatalog(candidate({ isrc: 'ESA452300137' }), OWNER);
    expect(result).toEqual({ kind: 'upload', uploadId: upload.id, tier: 'sha256' });
  });

  it('ISRC wins over the fingerprint tier', async () => {
    const byIsrc = await seedTrack({ externalIsrc: 'ESA452300137', duration: 30 });
    const byFingerprint = await seedTrack({ title: 'Other', duration: 30 });
    await seedFingerprint(byFingerprint.id, corpus.reference, 30);

    const result = await matchCatalog(
      candidate({
        sha256: 'b'.repeat(64),
        durationSec: 30,
        isrc: 'ESA452300137',
        fingerprint: corpus.reference,
      }),
      OWNER,
    );

    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(byIsrc.id);
    expect(result.tier).toBe('isrc');
  });

  it('the fingerprint tier wins over the fuzzy tier', async () => {
    const byFingerprint = await seedTrack({ title: 'Not The Same Title At All', duration: 30 });
    await seedFingerprint(byFingerprint.id, corpus.reference, 30);
    await seedTrack({ title: 'Midnight Ferry', duration: 30 });

    const result = await matchCatalog(
      candidate({ sha256: 'b'.repeat(64), durationSec: 30, fingerprint: corpus.reference }),
      OWNER,
    );

    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(byFingerprint.id);
    expect(result.tier).toBe('fingerprint');
  });
});

describe('normalizeForFuzzy', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(normalizeForFuzzy('Café  Soleil!')).toBe('cafe soleil');
    expect(normalizeForFuzzy('CAFE SOLEIL')).toBe('cafe soleil');
    expect(normalizeForFuzzy('  Sigur Rós  ')).toBe('sigur ros');
  });
});
