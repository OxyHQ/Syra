import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { clear, connect, disconnect } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { TrackFingerprintModel } from '../../models/TrackFingerprint';
import { UserUploadModel } from '../../models/UserUpload';
import { matchCatalog, normalizeForFuzzy, type MatchCandidate } from './matchCatalog';
import corpus from './__fixtures__/fingerprints.json';

beforeAll(connect);
beforeEach(async () => {
  await UserUploadModel.createIndexes();
});
afterEach(clear);
afterAll(disconnect);

const OWNER = 'oxy-user-uploader';
const OTHER_OWNER = 'oxy-user-someone-else';
const ARTIST_ID = new mongoose.Types.ObjectId().toString();

const SHA_OF_UPLOAD = 'a'.repeat(64);

async function seedTrack(overrides: Record<string, unknown> = {}) {
  return TrackModel.create({
    title: 'Midnight Ferry',
    artistId: ARTIST_ID,
    artistName: 'Nadia Ortiz',
    duration: 180,
    source: 'upload',
    status: 'ready',
    isAvailable: true,
    ...overrides,
  });
}

async function seedUpload(overrides: Record<string, unknown> = {}) {
  return UserUploadModel.create({
    ownerOxyUserId: OWNER,
    title: 'Midnight Ferry',
    duration: 180,
    sha256: SHA_OF_UPLOAD,
    sizeBytes: 4096,
    audioSource: { key: 'locker/x.mp3', format: 'mp3' },
    status: 'ready',
    ...overrides,
  });
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
      trackId: track._id.toString(),
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
    expect(result.trackId).toBe(track._id.toString());
  });

  it("finds the uploader's own locker copy", async () => {
    const upload = await seedUpload();
    const result = await matchCatalog(candidate(), OWNER);

    expect(result).toEqual({
      kind: 'upload',
      uploadId: upload._id.toString(),
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
    const track = await seedTrack({ externalIds: { isrc: 'ESA452300137' } });
    const result = await matchCatalog(
      candidate({ isrc: 'ESA452300137', title: undefined, artistName: undefined }),
      OWNER,
    );

    expect(result).toEqual({
      kind: 'track',
      trackId: track._id.toString(),
      tier: 'isrc',
      artistId: ARTIST_ID,
      artistName: 'Nadia Ortiz',
    });
  });

  it('normalises the ISRC to upper case before comparing', async () => {
    await seedTrack({ externalIds: { isrc: 'ESA452300137' } });
    const result = await matchCatalog(candidate({ isrc: 'esa452300137' }), OWNER);
    expect(result.kind).toBe('track');
  });

  it('does not match a track that is not playable', async () => {
    // A takedown must not resolve to "this is already in the catalog, add it to
    // your library" — the listener would get a track they cannot play.
    await seedTrack({ externalIds: { isrc: 'ESA452300137' }, copyrightRemoved: true });
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
    await TrackFingerprintModel.create({
      trackId: track._id.toString(),
      fingerprint: values,
      fingerprintDurationSec: durationSec,
    });
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
    expect(result.trackId).toBe(track._id.toString());
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
    await TrackModel.updateOne({ _id: track._id }, { copyrightRemoved: true });

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
    expect(result.nearestFingerprint?.trackId).toBe(track._id.toString());
    expect(result.nearestFingerprint?.artistId).toBe(ARTIST_ID);
    expect(result.nearestFingerprint?.copyrightRemoved).toBe(true);
    expect(result.nearestFingerprint?.bitErrorRate).toBeLessThan(0.01);
  });

  it('keeps the evidence for an unavailable track too, but not as a takedown', async () => {
    // A creator unpublishing their own track is not a copyright judgement. The
    // neighbour still feeds artist resolution; it must not fire a blocking marker.
    const track = await seedFingerprintedTrack(corpus.reference, 30);
    await TrackModel.updateOne({ _id: track._id }, { isAvailable: false });

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
    expect(result.nearestFingerprint?.trackId).toBe(track._id.toString());
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
    expect(result.trackId).toBe(track._id.toString());
  });

  /**
   * A sub-threshold candidate is NOT reported. At BER 0.15 the two are different
   * recordings; passing that on as evidence would manufacture a provenance
   * marker out of noise, against uploads least able to argue with it.
   */
  it('reports no neighbour for a candidate that never crossed the match threshold', async () => {
    const track = await seedFingerprintedTrack(corpus.closestNegativeA, 30);
    await TrackModel.updateOne({ _id: track._id }, { copyrightRemoved: true });

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
    expect(result.trackId).toBe(track._id.toString());
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
    await seedTrack({ externalIds: { isrc: 'ESA452300137' } });

    const result = await matchCatalog(candidate({ isrc: 'ESA452300137' }), OWNER);
    expect(result).toEqual({ kind: 'upload', uploadId: upload._id.toString(), tier: 'sha256' });
  });

  it('ISRC wins over the fingerprint tier', async () => {
    const byIsrc = await seedTrack({ externalIds: { isrc: 'ESA452300137' }, duration: 30 });
    const byFingerprint = await seedTrack({ title: 'Other', duration: 30 });
    await TrackFingerprintModel.create({
      trackId: byFingerprint._id.toString(),
      fingerprint: corpus.reference,
      fingerprintDurationSec: 30,
    });

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
    expect(result.trackId).toBe(byIsrc._id.toString());
    expect(result.tier).toBe('isrc');
  });

  it('the fingerprint tier wins over the fuzzy tier', async () => {
    const byFingerprint = await seedTrack({ title: 'Not The Same Title At All', duration: 30 });
    await TrackFingerprintModel.create({
      trackId: byFingerprint._id.toString(),
      fingerprint: corpus.reference,
      fingerprintDurationSec: 30,
    });
    await seedTrack({ title: 'Midnight Ferry', duration: 30 });

    const result = await matchCatalog(
      candidate({ sha256: 'b'.repeat(64), durationSec: 30, fingerprint: corpus.reference }),
      OWNER,
    );

    expect(result.kind).toBe('track');
    if (result.kind !== 'track') throw new Error('unreachable');
    expect(result.trackId).toBe(byFingerprint._id.toString());
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
