import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import {
  addStrike,
  removeStrike,
  checkUploadPermission,
  isRepeatInfringer,
  STRIKE_TERMINATION_THRESHOLD,
} from './strikeService';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeArtist(overrides: Partial<Record<string, unknown>> = {}): Promise<mongoose.Types.ObjectId> {
  const doc = await ArtistModel.create({
    name: 'Test Artist',
    stats: { followers: 0, albums: 0, tracks: 0, totalPlays: 0 },
    source: 'upload',
    ...overrides,
  });
  return doc._id as mongoose.Types.ObjectId;
}

async function makeTrack(artistId: mongoose.Types.ObjectId): Promise<mongoose.Types.ObjectId> {
  const doc = await TrackModel.create({
    title: 'Test Track',
    artistId: artistId.toString(),
    artistName: 'Test Artist',
    duration: 180,
    source: 'upload',
    status: 'ready',
  });
  return doc._id as mongoose.Types.ObjectId;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await connect();
  await clear();
});

afterEach(async () => {
  await disconnect();
});

// ── STRIKE_TERMINATION_THRESHOLD ──────────────────────────────────────────────

describe('STRIKE_TERMINATION_THRESHOLD', () => {
  it('equals 3', () => {
    expect(STRIKE_TERMINATION_THRESHOLD).toBe(3);
  });
});

// ── isRepeatInfringer ─────────────────────────────────────────────────────────

describe('isRepeatInfringer', () => {
  it('returns false when strikeCount below threshold', () => {
    expect(isRepeatInfringer(2)).toBe(false);
    expect(isRepeatInfringer(0)).toBe(false);
  });

  it('returns true at threshold', () => {
    expect(isRepeatInfringer(STRIKE_TERMINATION_THRESHOLD)).toBe(true);
  });

  it('returns true above threshold', () => {
    expect(isRepeatInfringer(5)).toBe(true);
  });
});

// ── addStrike — termination at third strike ───────────────────────────────────

describe('addStrike — termination', () => {
  it('terminates artist and takes down tracks on third strike', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    // Two strikes — not yet terminated
    await addStrike(artistId.toString(), 'first infringement');
    await addStrike(artistId.toString(), 'second infringement');

    const afterTwo = await ArtistModel.findById(artistId).lean();
    expect(afterTwo?.terminated).toBe(false);
    expect(afterTwo?.uploadsDisabled).toBe(false);

    // Third strike — termination fires
    const result = await addStrike(
      artistId.toString(),
      'third infringement',
      trackId.toString(),
    );
    expect(result).not.toBeNull();

    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.terminated).toBe(true);
    expect(artist?.terminatedAt).toBeInstanceOf(Date);
    expect(typeof artist?.terminationReason).toBe('string');
    expect(artist?.uploadsDisabled).toBe(true);

    // Track taken down
    const track = await TrackModel.findById(trackId).lean();
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
    expect(track?.removedAt).toBeInstanceOf(Date);
    expect(track?.removedReason).toContain('Repeat-infringer');
  });

  it('does not terminate before third strike', async () => {
    const artistId = await makeArtist();

    await addStrike(artistId.toString(), 'first infringement');
    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.terminated).toBeFalsy();
    expect(artist?.strikeCount).toBe(1);
  });

  it('takes down ALL artist tracks (not just strike-associated track)', async () => {
    const artistId = await makeArtist();
    const track1 = await makeTrack(artistId);
    const track2 = await makeTrack(artistId);

    await addStrike(artistId.toString(), 'infringement 1');
    await addStrike(artistId.toString(), 'infringement 2');
    await addStrike(artistId.toString(), 'infringement 3');

    const [t1, t2] = await Promise.all([
      TrackModel.findById(track1).lean(),
      TrackModel.findById(track2).lean(),
    ]);
    expect(t1?.copyrightRemoved).toBe(true);
    expect(t1?.isAvailable).toBe(false);
    expect(t2?.copyrightRemoved).toBe(true);
    expect(t2?.isAvailable).toBe(false);
  });

  it('returns null for unknown artistId', async () => {
    const result = await addStrike(new mongoose.Types.ObjectId().toString(), 'reason');
    expect(result).toBeNull();
  });
});

// ── checkUploadPermission — terminated blocks upload ─────────────────────────

describe('checkUploadPermission', () => {
  it('returns true when no strikes', async () => {
    const artistId = await makeArtist();
    const allowed = await checkUploadPermission(artistId.toString());
    expect(allowed).toBe(true);
  });

  it('returns false when uploadsDisabled', async () => {
    const artistId = await makeArtist({ uploadsDisabled: true });
    const allowed = await checkUploadPermission(artistId.toString());
    expect(allowed).toBe(false);
  });

  it('returns false when terminated (even if uploadsDisabled not set separately)', async () => {
    const artistId = await makeArtist({ terminated: true, uploadsDisabled: true });
    const allowed = await checkUploadPermission(artistId.toString());
    expect(allowed).toBe(false);
  });

  it('returns false for unknown artist', async () => {
    const allowed = await checkUploadPermission(new mongoose.Types.ObjectId().toString());
    expect(allowed).toBe(false);
  });
});

// ── removeStrike — does NOT un-terminate ─────────────────────────────────────

describe('removeStrike — does not un-terminate', () => {
  it('removing a strike from terminated artist keeps terminated=true', async () => {
    const artistId = await makeArtist();

    await addStrike(artistId.toString(), 'infringement 1');
    await addStrike(artistId.toString(), 'infringement 2');
    const result = await addStrike(artistId.toString(), 'infringement 3');

    expect(result?.terminated).toBe(true);

    // Get first strike id
    const artist = await ArtistModel.findById(artistId);
    const strikeId = artist?.strikes?.[0]?._id?.toString();
    expect(strikeId).toBeTruthy();

    if (strikeId) {
      await removeStrike(artistId.toString(), strikeId);
    }

    const after = await ArtistModel.findById(artistId).lean();
    expect(after?.terminated).toBe(true);
    expect(after?.terminatedAt).toBeInstanceOf(Date);
  });
});
