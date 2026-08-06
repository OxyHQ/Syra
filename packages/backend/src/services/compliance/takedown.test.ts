import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { connect, clear, disconnect } from '../../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { catalogEntities, trackFingerprints, tracks } from '../../db/schema/catalog';
import { UserUploadModel } from '../../models/UserUpload';
import { ContributionAttestationModel } from '../../models/ContributionAttestation';
import { ContributorStandingModel } from '../../models/ContributorStanding';
import {
  takeDownTrack,
  purgeLockerCopiesOfTrack,
  type LockerPurgeDeps,
  type LockerRemovalNotice,
} from './takedown';
import { playableTrackFilter } from '../../db/catalog/visibility';

/**
 * BOTH databases. The catalogue side (track, artist, fingerprint) is Postgres;
 * the safe-harbour locker purge is entirely `user_uploads`, `contribution_
 * attestations` and `contributor_standings` — Task 13's vertical, still Mongoose.
 */
beforeAll(async () => {
  await connect();
  await connectDb();
});
afterEach(async () => {
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

async function readArtist(artistId: string) {
  const [artist] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, artistId))
    .limit(1);
  return artist;
}

async function readTrack(trackId: string) {
  const [track] = await getDb().select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  return track;
}

// ── Storage spy ───────────────────────────────────────────────────────────────

interface StorageSpy extends LockerPurgeDeps {
  deletedKeys: string[];
  deletedPrefixes: string[];
  notices: LockerRemovalNotice[];
}

/**
 * Records what the purge ASKS storage to delete.
 *
 * `deletePrefix` reports a non-zero count so a caller that only ever swept
 * prefixes still shows objects deleted — and so a purge that swept nothing is
 * visibly different from one that swept a directory.
 */
function makeStorageSpy(objectsPerPrefix = 3): StorageSpy {
  const spy: StorageSpy = {
    deletedKeys: [],
    deletedPrefixes: [],
    notices: [],
    deleteObject: async (key: string) => { spy.deletedKeys.push(key); },
    deletePrefix: async (prefix: string) => {
      spy.deletedPrefixes.push(prefix);
      return objectsPerPrefix;
    },
    // Captured rather than sent: the real notifier needs Oxy credentials, and a
    // test that let it fail silently would assert nothing about the notice.
    notifyRemoval: async (notice) => { spy.notices.push(notice); },
  };
  return spy;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function makeArtist(
  overrides: Partial<typeof catalogEntities.$inferInsert> = {}
): Promise<string> {
  const suffix = uuidv7();
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name: `Artist ${suffix}`,
      nameKey: `artist-${suffix}`,
      source: 'upload',
      ...overrides,
    })
    .returning({ id: catalogEntities.id });

  if (!artist) throw new Error('makeArtist: insert returned no row');
  return artist.id;
}

async function makeTrack(artistId: string, title = 'Contributed Song'): Promise<string> {
  const [track] = await getDb()
    .insert(tracks)
    .values({
      title,
      artistId,
      artistName: 'Whoever',
      duration: 210,
      source: 'upload',
      status: 'ready',
    })
    .returning({ id: tracks.id });

  if (!track) throw new Error('makeTrack: insert returned no row');
  return track.id;
}

/**
 * A deterministic pseudo-fingerprint, long enough to clear the comparator's
 * minimum overlap. Two calls with different seeds are unrelated audio.
 */
function makeFingerprint(seed = 0x1234, items = 1600): number[] {
  const values: number[] = [];
  let state = seed >>> 0;
  for (let i = 0; i < items; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    values.push(state | 0);
  }
  return values;
}

/** Flip roughly `rate` of the bits — a different encoding of the same recording. */
function perturb(fingerprint: number[], rate: number): number[] {
  let state = 0x9e3779b9;
  return fingerprint.map((value) => {
    let out = value;
    for (let bit = 0; bit < 32; bit += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      if (state / 0x100000000 < rate) out ^= 1 << bit;
    }
    return out | 0;
  });
}

async function makeLockerFile(options: {
  owner: string;
  sha256: string;
  matchedTrackId?: string;
  withHls?: boolean;
  fingerprint?: number[];
  fingerprintDurationSec?: number;
}): Promise<string> {
  const id = new mongoose.Types.ObjectId();
  await UserUploadModel.create({
    _id: id,
    ownerOxyUserId: options.owner,
    title: 'A file',
    duration: 210,
    sizeBytes: 5_000_000,
    sha256: options.sha256,
    matchedTrackId: options.matchedTrackId,
    status: 'ready',
    fingerprint: options.fingerprint,
    fingerprintDurationSec: options.fingerprintDurationSec,
    audioSource: { key: `audio/${options.owner}/${id.toString()}.mp3`, format: 'mp3' },
    ...(options.withHls
      ? {
          hlsMasterKey: `hls/${options.owner}/${id.toString()}/master.m3u8`,
          hls: [{
            manifestKey: `hls/${options.owner}/${id.toString()}/160/index.m3u8`,
            bitrateKbps: 160,
            encrypted: true,
          }],
        }
      : {}),
  });
  return id.toString();
}

// ── Locker purge ──────────────────────────────────────────────────────────────

describe('purgeLockerCopiesOfTrack — safe-harbour purge', () => {
  it('deletes the linked locker file AND every same-sha256 copy in other lockers', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    const mine = await makeLockerFile({ owner: 'user-a', sha256: 'sha-abc', matchedTrackId: trackId });
    const theirs = await makeLockerFile({ owner: 'user-b', sha256: 'sha-abc' });
    const unrelated = await makeLockerFile({ owner: 'user-c', sha256: 'sha-zzz' });

    const spy = makeStorageSpy();
    const result = await purgeLockerCopiesOfTrack(trackId, spy);

    expect(result.uploadsDeleted).toBe(2);
    expect(result.affectedOwnerIds.sort()).toEqual(['user-a', 'user-b']);

    expect(await UserUploadModel.findById(mine).lean()).toBeNull();
    expect(await UserUploadModel.findById(theirs).lean()).toBeNull();
    // Somebody else's unrelated music must survive a takedown of this recording.
    expect(await UserUploadModel.findById(unrelated).lean()).not.toBeNull();
  });

  it('deletes the STORED OBJECTS, not just the documents', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const uploadId = await makeLockerFile({
      owner: 'user-a',
      sha256: 'sha-abc',
      matchedTrackId: trackId,
      withHls: true,
    });

    const spy = makeStorageSpy(4);
    const result = await purgeLockerCopiesOfTrack(trackId, spy);

    // The audio object is named explicitly...
    expect(spy.deletedKeys).toContain(`audio/user-a/${uploadId}.mp3`);
    // ...and the HLS directory is SWEPT, because the segments beside the manifests
    // are named by the packager and recorded nowhere. Deleting only the recorded
    // manifests would leave the actual audio in the bucket.
    expect(spy.deletedPrefixes).toEqual([`hls/user-a/${uploadId}/`]);
    // The manifests live under that prefix and must not be deleted twice.
    expect(spy.deletedKeys).not.toContain(`hls/user-a/${uploadId}/master.m3u8`);
    expect(result.objectsDeleted).toBe(5); // 4 swept + 1 audio object
  });

  /**
   * Ingest can die after writing segments and before recording a master manifest.
   * The directory still has to be swept, so the prefix is derived from ANY
   * recorded key, not from the master alone.
   */
  it('sweeps from a rendition manifest when no master key was ever recorded', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const id = new mongoose.Types.ObjectId();
    await UserUploadModel.create({
      _id: id,
      ownerOxyUserId: 'user-a',
      title: 'Half-ingested file',
      duration: 210,
      sizeBytes: 1,
      sha256: 'sha-no-master',
      matchedTrackId: trackId,
      status: 'failed',
      hls: [{
        manifestKey: `hls/uploads/user-a/${id.toString()}/160/index.m3u8`,
        bitrateKbps: 160,
        encrypted: true,
      }],
    });

    const spy = makeStorageSpy();
    await purgeLockerCopiesOfTrack(trackId, spy);

    expect(spy.deletedPrefixes).toEqual([`hls/uploads/user-a/${id.toString()}/`]);
  });

  /**
   * The source object is `.../{uploadId}.{format}` — the id is part of a FILENAME
   * in a directory shared with the owner's other uploads. A substring test would
   * accept that parent and empty their entire locker.
   */
  it('never sweeps the shared parent of the source object, whose NAME carries the id', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const id = new mongoose.Types.ObjectId();
    await UserUploadModel.create({
      _id: id,
      ownerOxyUserId: 'user-a',
      title: 'Source only',
      duration: 210,
      sizeBytes: 1,
      sha256: 'sha-source-only',
      matchedTrackId: trackId,
      status: 'ready',
      audioSource: { key: `uploads/user-a/${id.toString()}.mp3`, format: 'mp3' },
    });

    const spy = makeStorageSpy();
    await purgeLockerCopiesOfTrack(trackId, spy);

    expect(spy.deletedPrefixes).toEqual([]);
    expect(spy.deletedKeys).toEqual([`uploads/user-a/${id.toString()}.mp3`]);
  });

  it('never sweeps a prefix that is not scoped to the file being deleted', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const id = new mongoose.Types.ObjectId();
    await UserUploadModel.create({
      _id: id,
      ownerOxyUserId: 'user-a',
      title: 'A file',
      duration: 210,
      sizeBytes: 1,
      sha256: 'sha-shared-dir',
      matchedTrackId: trackId,
      status: 'ready',
      // A master manifest sitting in a directory shared with other files: sweeping
      // it would delete somebody else's audio.
      hlsMasterKey: 'hls/shared/master.m3u8',
      hls: [{ manifestKey: 'hls/shared/160/index.m3u8', bitrateKbps: 160, encrypted: true }],
    });

    const spy = makeStorageSpy();
    await purgeLockerCopiesOfTrack(trackId, spy);

    expect(spy.deletedPrefixes).toEqual([]);
    // Only the keys the document itself recorded.
    expect(spy.deletedKeys.sort()).toEqual([
      'hls/shared/160/index.m3u8',
      'hls/shared/master.m3u8',
    ]);
  });

  /**
   * The leg that catches a RE-ENCODE. Different bytes, different sha, no
   * `matchedTrackId` — the two legs above see nothing, and a work a rightsholder
   * identified would keep being served from lockers in a different bitrate.
   */
  it('deletes an acoustic match that shares neither sha256 nor a link', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const fingerprint = makeFingerprint();
    await getDb().insert(trackFingerprints).values({
      trackId,
      fingerprint,
      fingerprintDurationSec: 210,
    });

    const reencode = await makeLockerFile({
      owner: 'user-r',
      sha256: 'a-completely-different-hash',
      fingerprint: perturb(fingerprint, 0.02), // ~2% bit error: the same recording
      fingerprintDurationSec: 211,
    });
    const otherMusic = await makeLockerFile({
      owner: 'user-r',
      sha256: 'yet-another-hash',
      fingerprint: makeFingerprint(0xbeef), // unrelated audio, same length
      fingerprintDurationSec: 210,
    });

    const result = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(result.uploadsDeleted).toBe(1);
    expect(await UserUploadModel.findById(reencode).lean()).toBeNull();
    expect(await UserUploadModel.findById(otherMusic).lean()).not.toBeNull();
  });

  it('leaves the acoustic leg out when the catalog track has no fingerprint', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    const untouched = await makeLockerFile({
      owner: 'user-r',
      sha256: 'unrelated',
      fingerprint: makeFingerprint(),
      fingerprintDurationSec: 210,
    });

    const result = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(result.uploadsDeleted).toBe(0);
    expect(await UserUploadModel.findById(untouched).lean()).not.toBeNull();
  });

  /**
   * "No re-encode was found" and "re-encodes were never looked for" must not be
   * the same answer. The creator/studio upload path writes no fingerprint row and
   * the existing catalogue has never been backfilled, so a takedown that can only
   * compare hashes is the COMMON case — and it has to say so.
   */
  it('reports that acoustic matching was UNAVAILABLE when the track has no fingerprint', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    await makeLockerFile({ owner: 'user-a', sha256: 'sha-abc', matchedTrackId: trackId });

    const result = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    // The hash leg still worked — this is a degradation, not a failure.
    expect(result.uploadsDeleted).toBe(1);
    expect(result.acousticMatchingAvailable).toBe(false);
  });

  it('reports it as AVAILABLE once the track is acoustically indexed', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    await getDb().insert(trackFingerprints).values({
      trackId, fingerprint: makeFingerprint(), fingerprintDurationSec: 210,
    });
    await makeLockerFile({ owner: 'user-a', sha256: 'sha-abc', matchedTrackId: trackId });

    const result = await purgeLockerCopiesOfTrack(trackId, makeStorageSpy());

    expect(result.acousticMatchingAvailable).toBe(true);
  });

  it('is a no-op when no locker holds the recording', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    const spy = makeStorageSpy();
    const result = await purgeLockerCopiesOfTrack(trackId, spy);

    expect(result).toEqual({
      uploadsDeleted: 0,
      objectsDeleted: 0,
      affectedOwnerIds: [],
      // This track has no fingerprint row, so the acoustic leg never ran.
      acousticMatchingAvailable: false,
    });
    expect(spy.deletedKeys).toEqual([]);
  });
});

// ── Takedown ──────────────────────────────────────────────────────────────────

describe('takeDownTrack', () => {
  it('removes the track from BOTH the catalog and playback, and purges lockers', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    await makeLockerFile({ owner: 'user-a', sha256: 'sha-abc', matchedTrackId: trackId });

    const spy = makeStorageSpy();
    const result = await takeDownTrack(
      { trackId, reason: 'DMCA notice', actorOxyUserId: 'reviewer-1' },
      spy,
    );

    expect(result).not.toBeNull();
    const track = await readTrack(trackId);
    expect(track?.copyrightRemoved).toBe(true);
    expect(track?.isAvailable).toBe(false);
    expect(track?.removedBy).toBe('reviewer-1');
    expect(
      await getDb()
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(eq(tracks.artistId, artistId), playableTrackFilter()))
    ).toHaveLength(0);

    expect(result?.purge.uploadsDeleted).toBe(1);
    expect(await UserUploadModel.countDocuments({})).toBe(0);
  });

  it('returns null for a track that does not exist', async () => {
    const result = await takeDownTrack({
      trackId: new mongoose.Types.ObjectId().toString(),
      reason: 'nope',
      actorOxyUserId: 'reviewer-1',
    });
    expect(result).toBeNull();
  });

  it('strikes the artist directly when the track was their own upload', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: 'creator-1' });
    const trackId = await makeTrack(artistId);

    const result = await takeDownTrack(
      { trackId, reason: 'DMCA notice', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );

    expect(result?.strike).toEqual({
      applied: true,
      against: 'artist',
      artistId,
      strikeCount: 1,
      terminated: false,
    });
  });

  /**
   * The trap this exists to close: a contributed track hangs from the profile of
   * the artist it is ATTRIBUTED to — frequently the person the recording was
   * taken FROM. Striking `track.artistId` would punish them for a stranger's
   * upload and terminate them at the third one.
   */
  it('strikes the CONTRIBUTOR, never the artist the track is filed under', async () => {
    const victimArtistId = await makeArtist({ ownerOxyUserId: 'the-real-artist' });
    const contributorArtistId = await makeArtist({ ownerOxyUserId: 'the-contributor' });
    const trackId = await makeTrack(victimArtistId);

    await ContributionAttestationModel.create({
      trackId,
      uploaderOxyUserId: 'the-contributor',
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
    });

    const result = await takeDownTrack(
      { trackId, reason: 'DMCA notice', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );

    expect(result?.strike).toEqual({
      applied: true,
      against: 'artist',
      artistId: contributorArtistId,
      strikeCount: 1,
      terminated: false,
    });

    const victim = await readArtist(victimArtistId);
    expect(victim?.strikeCount ?? 0).toBe(0);
    expect(victim?.uploadsDisabled ?? false).toBe(false);
  });

  /**
   * The population the public contribution path creates: somebody who publishes
   * to the catalogue without ever registering as an artist. Their strike used to
   * have nowhere to go, which meant the repeat-infringer policy could not reach
   * the accounts most likely to need it. It now lands on their Oxy account.
   */
  it('strikes the ACCOUNT when the contributor has no artist profile', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: 'the-real-artist' });
    const trackId = await makeTrack(artistId);

    await ContributionAttestationModel.create({
      trackId,
      uploaderOxyUserId: 'a-listener-with-no-profile',
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
    });

    const result = await takeDownTrack(
      { trackId, reason: 'DMCA notice', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );

    expect(result?.strike).toEqual({
      applied: true,
      against: 'contributor',
      oxyUserId: 'a-listener-with-no-profile',
      strikeCount: 1,
      terminated: false,
    });

    const standing = await ContributorStandingModel.findOne({
      oxyUserId: 'a-listener-with-no-profile',
    }).lean();
    expect(standing?.strikeCount).toBe(1);
    expect(standing?.terminated).toBe(false);

    // And still not the artist whose page the recording hung from.
    const artist = await readArtist(artistId);
    expect(artist?.strikeCount ?? 0).toBe(0);
  });

  /**
   * One work is one strike. Without this, three replays of the same takedown —
   * a double-tapped button, a redelivered request — would terminate an account
   * for a single infringement.
   */
  it('does NOT strike again when the work was already taken down', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: 'creator-1' });
    const trackId = await makeTrack(artistId);

    const first = await takeDownTrack(
      { trackId, reason: 'DMCA notice', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );
    expect(first?.strike).toEqual({ applied: true, against: 'artist', artistId, strikeCount: 1, terminated: false });

    const replay = await takeDownTrack(
      { trackId, reason: 'DMCA notice again', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );
    expect(replay?.alreadyRemoved).toBe(true);
    expect(replay?.strike).toEqual({ applied: false, code: 'already_removed' });

    const artist = await readArtist(artistId);
    expect(artist?.strikeCount).toBe(1);
    expect(artist?.terminated).toBe(false);
  });

  it('still purges lockers on a replay — a copy may have appeared since', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: 'creator-1' });
    const trackId = await makeTrack(artistId);

    await takeDownTrack({ trackId, reason: 'notice', actorOxyUserId: 'reviewer-1' }, makeStorageSpy());

    const late = await makeLockerFile({ owner: 'user-late', sha256: 'sha-late', matchedTrackId: trackId });
    const replay = await takeDownTrack(
      { trackId, reason: 'notice', actorOxyUserId: 'reviewer-1' },
      makeStorageSpy(),
    );

    expect(replay?.purge.uploadsDeleted).toBe(1);
    expect(await UserUploadModel.findById(late).lean()).toBeNull();
  });

  it('terminates on the third strike, takes down every track, and purges their lockers too', async () => {
    const artistId = await makeArtist({ ownerOxyUserId: 'creator-1' });
    const first = await makeTrack(artistId, 'One');
    const second = await makeTrack(artistId, 'Two');
    const third = await makeTrack(artistId, 'Three');
    /**
     * A FOURTH track nobody ever reported, with a locker copy of its own.
     *
     * This is what separates the termination sweep from the per-report purge:
     * termination takes this track down in a bulk update inside `strikeService`,
     * and if the purge only followed the reported track its locker copy would
     * survive as an infringing file the platform still serves.
     */
    const unreported = await makeTrack(artistId, 'Four');
    const collateral = await makeLockerFile({
      owner: 'user-z',
      sha256: 'sha-collateral',
      matchedTrackId: unreported,
    });

    const spy = makeStorageSpy();
    await takeDownTrack({ trackId: first, reason: 'notice 1', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: second, reason: 'notice 2', actorOxyUserId: 'reviewer-1' }, spy);

    const notYet = await readArtist(artistId);
    expect(notYet?.terminated).toBe(false);

    const result = await takeDownTrack(
      { trackId: third, reason: 'notice 3', actorOxyUserId: 'reviewer-1' },
      spy,
    );

    expect(result?.strike).toEqual({
      applied: true,
      against: 'artist',
      artistId,
      strikeCount: 3,
      terminated: true,
    });

    const artist = await readArtist(artistId);
    expect(artist?.terminated).toBe(true);
    expect(artist?.uploadsDisabled).toBe(true);

    const artistTracks = await getDb().select().from(tracks).where(eq(tracks.artistId, artistId));
    expect(artistTracks).toHaveLength(4);
    for (const track of artistTracks) {
      expect(track.copyrightRemoved).toBe(true);
      expect(track.isAvailable).toBe(false);
    }

    // The never-reported track's locker copy went with it.
    expect(await UserUploadModel.findById(collateral).lean()).toBeNull();
    expect(await UserUploadModel.countDocuments({})).toBe(0);
  });
});

// ── Telling the owner ─────────────────────────────────────────────────────────

describe('locker removal notices', () => {
  it('tells each affected owner ONCE, with how many files they lost', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);
    await makeLockerFile({ owner: 'user-a', sha256: 'sha-abc', matchedTrackId: trackId });
    await makeLockerFile({ owner: 'user-b', sha256: 'sha-abc' });
    await makeLockerFile({ owner: 'user-b', sha256: 'sha-abc-2', matchedTrackId: trackId });

    const spy = makeStorageSpy();
    await purgeLockerCopiesOfTrack(trackId, spy);

    expect(spy.notices).toHaveLength(2);
    const byOwner = new Map(spy.notices.map((notice) => [notice.ownerOxyUserId, notice]));
    expect(byOwner.get('user-a')).toEqual({
      ownerOxyUserId: 'user-a', fileCount: 1, cause: 'takedown',
    });
    expect(byOwner.get('user-b')).toEqual({
      ownerOxyUserId: 'user-b', fileCount: 2, cause: 'takedown',
    });
  });

  it('says nothing when no locker lost anything', async () => {
    const artistId = await makeArtist();
    const trackId = await makeTrack(artistId);

    const spy = makeStorageSpy();
    await purgeLockerCopiesOfTrack(trackId, spy);

    expect(spy.notices).toEqual([]);
  });
});

// ── Contributor accountability ────────────────────────────────────────────────

/**
 * The repeat-infringer policy reaching the population that has no artist
 * profile. Before this, a listener could contribute infringing recordings
 * indefinitely: every takedown reported "nowhere to put the strike" and the
 * threshold was unreachable by construction.
 */
describe('contributor termination', () => {
  async function contributeTrack(uploader: string, title = 'Contributed'): Promise<string> {
    const artistId = await makeArtist({ ownerOxyUserId: 'the-real-artist' });
    const trackId = await makeTrack(artistId, title);
    await ContributionAttestationModel.create({
      trackId,
      uploaderOxyUserId: uploader,
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
    });
    return trackId;
  }

  it('terminates the ACCOUNT on the third strike', async () => {
    const spy = makeStorageSpy();
    const first = await contributeTrack('serial-uploader', 'One');
    const second = await contributeTrack('serial-uploader', 'Two');
    const third = await contributeTrack('serial-uploader', 'Three');

    await takeDownTrack({ trackId: first, reason: 'notice 1', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: second, reason: 'notice 2', actorOxyUserId: 'reviewer-1' }, spy);

    const beforeThird = await ContributorStandingModel.findOne({ oxyUserId: 'serial-uploader' }).lean();
    expect(beforeThird?.strikeCount).toBe(2);
    expect(beforeThird?.terminated).toBe(false);

    const result = await takeDownTrack(
      { trackId: third, reason: 'notice 3', actorOxyUserId: 'reviewer-1' },
      spy,
    );

    expect(result?.strike).toEqual({
      applied: true,
      against: 'contributor',
      oxyUserId: 'serial-uploader',
      strikeCount: 3,
      terminated: true,
    });

    const standing = await ContributorStandingModel.findOne({ oxyUserId: 'serial-uploader' }).lean();
    expect(standing?.terminated).toBe(true);
    expect(standing?.uploadsDisabled).toBe(true);
    expect(typeof standing?.terminationReason).toBe('string');
  });

  it('takes down every recording they contributed, not only the reported one', async () => {
    const spy = makeStorageSpy();
    const reported = await contributeTrack('serial-uploader', 'Reported');
    const alsoTheirs = await contributeTrack('serial-uploader', 'Never Reported');
    const second = await contributeTrack('serial-uploader', 'Two');

    await takeDownTrack({ trackId: second, reason: 'notice 1', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: alsoTheirs, reason: 'notice 2', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: reported, reason: 'notice 3', actorOxyUserId: 'reviewer-1' }, spy);

    for (const id of [reported, alsoTheirs, second]) {
      const track = await readTrack(id);
      expect(track?.copyrightRemoved).toBe(true);
      expect(track?.isAvailable).toBe(false);
    }
  });

  it('purges their WHOLE locker, including files unrelated to the complaint', async () => {
    const spy = makeStorageSpy();
    const one = await contributeTrack('serial-uploader', 'One');
    const two = await contributeTrack('serial-uploader', 'Two');
    const three = await contributeTrack('serial-uploader', 'Three');

    // Their own private music, matching no taken-down recording.
    const ownFile = await makeLockerFile({ owner: 'serial-uploader', sha256: 'sha-private' });
    // Somebody else's locker must be untouched by this account's termination.
    const bystander = await makeLockerFile({ owner: 'innocent-user', sha256: 'sha-other' });

    await takeDownTrack({ trackId: one, reason: 'notice 1', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: two, reason: 'notice 2', actorOxyUserId: 'reviewer-1' }, spy);
    await takeDownTrack({ trackId: three, reason: 'notice 3', actorOxyUserId: 'reviewer-1' }, spy);

    expect(await UserUploadModel.findById(ownFile).lean()).toBeNull();
    expect(await UserUploadModel.findById(bystander).lean()).not.toBeNull();
    expect(spy.deletedKeys.some((key) => key.includes('serial-uploader'))).toBe(true);

    const termination = spy.notices.find((notice) => notice.cause === 'termination');
    expect(termination).toEqual({
      ownerOxyUserId: 'serial-uploader', fileCount: 1, cause: 'termination',
    });
  });

  it('does not touch the artist profile the recordings hung from', async () => {
    const spy = makeStorageSpy();
    const trackId = await contributeTrack('serial-uploader');
    const track = await readTrack(trackId);

    await takeDownTrack({ trackId, reason: 'notice', actorOxyUserId: 'reviewer-1' }, spy);

    const victim = await readArtist(track?.artistId ?? '');
    expect(victim?.strikeCount ?? 0).toBe(0);
    expect(victim?.terminated ?? false).toBe(false);
  });
});
