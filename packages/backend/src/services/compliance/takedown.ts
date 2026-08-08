import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { catalogEntities, trackFingerprints, tracks } from '../../db/schema/catalog';
import {
  findAttestationUploader,
  findContributedTrackIds,
} from '../../db/creators/attestations';
import {
  deleteUploads,
  findFingerprintCandidates,
  findLockerStorageRefs,
  findUploadsBySha256,
  findUploadsMatchedToTrack,
  type UploadStorageRef,
} from '../../db/creators/uploads';
import { deleteFromS3, deleteS3Prefix } from '../s3Service';
import { addStrike } from '../strikeService';
import { recordContributorStrike } from './contributorStrikes';
import { compareFingerprints } from '../uploads/fingerprint';
import { notifyUser } from '../notifications/notifier';
import { logger } from '../../utils/logger';

/**
 * Carrying out a copyright takedown, end to end.
 *
 * A takedown is three things, and it is not done until all three have happened:
 *
 * 1. The track leaves the catalog AND playback — `copyrightRemoved` gates
 *    `isTrackPlayable`, `isAvailable` gates `playableTrackFilter`, and a takedown
 *    that sets only one of them leaves the work listed and searchable but broken,
 *    or playable but invisible. Both, always, as `strikeService` already does.
 * 2. Every private locker holding the same recording is purged, documents AND
 *    stored bytes. Safe harbour is conditioned on removing the identified work,
 *    and a file the platform keeps serving to the person who uploaded it has not
 *    been removed — this is a requirement, not a tidy-up.
 * 3. The party RESPONSIBLE for the publication takes the strike, which is
 *    frequently not the artist the track is filed under (see
 *    {@link resolveResponsible}).
 *
 * Ordering is deliberate: removal, then purge, then strike. If the strike throws,
 * the work is already gone; the reverse ordering could leave an infringing file
 * being served because a bookkeeping write failed.
 */

/**
 * The candidate bucket for an acoustic match, in seconds either side.
 *
 * Same window as the upload matcher's: a takedown that used a different one
 * would disagree with the dedup chain about whether two files are the same
 * recording.
 */
const FINGERPRINT_DURATION_WINDOW_SEC = 3;

/**
 * Storage side effects, injectable so tests can assert WHICH keys a purge asks
 * to delete without an S3 endpoint. Production passes nothing and gets S3.
 */
export interface LockerPurgeDeps {
  deleteObject?: (key: string) => Promise<void>;
  deletePrefix?: (prefix: string) => Promise<number>;
  /** Told once per owner whose locker lost files. Injectable so tests need no Oxy credentials. */
  notifyRemoval?: (notice: LockerRemovalNotice) => Promise<void>;
}

export interface LockerRemovalNotice {
  ownerOxyUserId: string;
  fileCount: number;
  /** `takedown` — this recording was removed. `termination` — the account was. */
  cause: 'takedown' | 'termination';
}

export interface LockerPurgeResult {
  /** `UserUpload` documents deleted. */
  uploadsDeleted: number;
  /** Stored objects deleted (audio, manifests and every HLS segment beside them). */
  objectsDeleted: number;
  /** Distinct owners whose locker lost a file — the addressees of a notice. */
  affectedOwnerIds: string[];
  /**
   * Whether the ACOUSTIC leg could run — i.e. whether the taken-down track has a
   * `TrackFingerprint` row to compare locker files against.
   *
   * Reported rather than assumed, because without it "no re-encode was found" and
   * "re-encodes were never looked for" are the same observable outcome, and for a
   * work a rightsholder has identified those are very different answers. Tracks
   * published through the creator/studio path carry no fingerprint today, so this
   * is `false` for most of the existing catalogue — the purge then matches only
   * byte-identical copies and a different encoding of the same recording survives
   * in every locker holding one.
   */
  acousticMatchingAvailable: boolean;
}

/**
 * Where the strike landed.
 *
 * `artist` and `contributor` are the two populations the repeat-infringer policy
 * has to reach, and they are reported separately rather than collapsed into one
 * id: a reviewer looking at the result needs to know whether an artist profile or
 * an ordinary account just took a strike, because only one of those has a
 * catalogue behind it.
 */
export type StrikeOutcome =
  | { applied: true; against: 'artist'; artistId: string; strikeCount: number; terminated: boolean }
  | { applied: true; against: 'contributor'; oxyUserId: string; strikeCount: number; terminated: boolean }
  | {
      applied: false;
      /**
       * `already_removed` — this work was taken down before, so it has already
       * been counted. One work is one strike, however many times the takedown is
       * replayed; without this, three clicks on the same track would terminate an
       * account for a single infringement.
       *
       * `artist_not_found` — the track names an artist row that no longer exists.
       */
      code: 'artist_not_found' | 'already_removed';
    };

export interface TakeDownTrackInput {
  trackId: string;
  /** Recorded on the track as `removedReason` and on the strike. */
  reason: string;
  /** Oxy user id of whoever authorised this — a reviewer, or the artist whose profile carries the track. */
  actorOxyUserId: string;
  copyrightReportId?: string;
}

export interface TakeDownTrackResult {
  trackId: string;
  /** True when the track was already copyright-removed; the purge still runs. */
  alreadyRemoved: boolean;
  strike: StrikeOutcome;
  purge: LockerPurgeResult;
}

// ── Locker purge ──────────────────────────────────────────────────────────────

// `UploadStorageRef` — where one locker file's bytes are — is declared by
// `db/creators/uploads.ts` and imported above. It lived here because this module
// owned the only reader; the sweeper needs the same shape from the same
// projection, and two declarations of "the fields a delete reads" would drift
// with the half that drifted leaving audio in the bucket.

/**
 * Tell somebody their music is gone.
 *
 * A file vanishing from a private library with no explanation is
 * indistinguishable from a bug, and nobody can appeal a removal they were never
 * told about — so this is part of the removal, not a courtesy attached to it.
 *
 * Coalesced per owner: a termination or a widely-copied recording deletes many
 * files at once and that is ONE piece of news, not one push per file. The
 * notifier swallows its own failures by design; a notice that cannot be sent must
 * never leave an infringing file in place.
 */
async function announceRemoval(
  notice: LockerRemovalNotice,
  deps: LockerPurgeDeps,
): Promise<void> {
  if (deps.notifyRemoval) {
    await deps.notifyRemoval(notice);
    return;
  }

  const plural = notice.fileCount === 1 ? 'file' : 'files';
  await notifyUser({
    recipientId: notice.ownerOxyUserId,
    actorId: notice.ownerOxyUserId,
    event: 'upload.removed',
    entityId: `${notice.cause}:${notice.ownerOxyUserId}:${Date.now()}`,
    entityType: 'upload',
    title: `${notice.fileCount} ${plural} removed from your library`,
    message: notice.cause === 'termination'
      ? `${notice.fileCount} ${plural} were removed and your account can no longer publish ` +
        'to the public catalogue, following repeated copyright complaints.'
      : `${notice.fileCount} ${plural} were removed from your library after a copyright ` +
        'complaint about that recording.',
    data: { cause: notice.cause, fileCount: notice.fileCount },
    coalesceGroupId: `upload-removed:${notice.ownerOxyUserId}`,
  });
}

/** Every stored object this locker file recorded a key for. */
function recordedObjectKeys(upload: UploadStorageRef): string[] {
  const keys: string[] = [];
  if (upload.audioSourceKey) keys.push(upload.audioSourceKey);
  if (upload.hlsMasterKey) keys.push(upload.hlsMasterKey);
  for (const rendition of upload.hls) {
    if (rendition.manifestKey) keys.push(rendition.manifestKey);
  }
  return [...new Set(keys)];
}

/**
 * The directory this file's HLS output lives in, when one can be named safely.
 *
 * HLS output is a DIRECTORY, and only the manifests are recorded — the segments
 * beside them are named by the packager and stored nowhere. Deleting the recorded
 * keys alone leaves the actual audio in the bucket, which for a copyright takedown
 * is the difference between removing a work and merely removing its index. So the
 * directory has to be swept, and to sweep it we have to name it.
 *
 * Derived from the keys the DOCUMENT recorded rather than rebuilt from a key
 * layout assumed here: ingest owns that layout, and a prefix composed from a
 * remembered convention sweeps nothing on the day the convention changes —
 * silently, since deleting zero objects raises no error.
 *
 * The guard is that the upload's own id must appear as a whole PATH SEGMENT that
 * is not the filename, and that requirement is what stands between this function
 * and deleting somebody's entire locker. Taking the plain parent directory
 * instead — the obvious implementation — turns the source object
 * `uploads/{owner}/{uploadId}.mp3` into the prefix `uploads/{owner}/`, which is
 * every file that owner has. Four tests fail if the id requirement is removed;
 * that is deliberate, because nothing about the resulting call looks wrong.
 *
 * Every recorded key is considered, not just the master manifest, so an upload
 * whose ingest died before it recorded a master is still swept from a rendition
 * manifest.
 */
function hlsDirectoryPrefix(upload: UploadStorageRef): string | undefined {
  const uploadId = upload.id;

  for (const key of recordedObjectKeys(upload)) {
    const segments = key.split('/');
    const index = segments.indexOf(uploadId);
    // `< length - 1` excludes a trailing match: that is a file named after the
    // upload, and its parent belongs to somebody else's files too.
    if (index >= 0 && index < segments.length - 1) {
      return `${segments.slice(0, index + 1).join('/')}/`;
    }
  }

  return undefined;
}

/**
 * Delete everything one locker file has in storage, and say how many objects went.
 *
 * Exported because a takedown is not the only reason a locker file dies — the
 * retention sweeper deletes expired files too, and it must delete exactly the same
 * set. Two implementations of "what belongs to this upload" would drift, and the
 * half that drifts leaves audio in the bucket after its document is gone.
 */
export async function deleteUploadStoredObjects(
  upload: UploadStorageRef,
  deps: LockerPurgeDeps = {},
): Promise<number> {
  const deleteObject = deps.deleteObject ?? deleteFromS3;
  const deletePrefix = deps.deletePrefix ?? deleteS3Prefix;
  const prefix = hlsDirectoryPrefix(upload);
  let deleted = 0;

  if (prefix) {
    deleted += await deletePrefix(prefix);
  } else if (upload.hlsMasterKey || upload.hls.length > 0) {
    /**
     * HLS output exists but no directory could be scoped to this upload alone, so
     * the manifests below are deleted and the segments are NOT. Loud on purpose:
     * an orphan here costs storage silently and, after a takedown, means bytes
     * that were supposed to be gone are still in the bucket. The message names the
     * upload so the objects can be found.
     */
    logger.warn(
      `[Takedown] Could not scope an HLS directory to upload ${upload.id} — ` +
      'its segments may be orphaned. Recorded keys: ' +
      `${recordedObjectKeys(upload).join(', ') || '(none)'}`,
    );
  }

  for (const key of recordedObjectKeys(upload)) {
    if (prefix && key.startsWith(prefix)) continue; // already swept
    await deleteObject(key);
    deleted += 1;
  }

  return deleted;
}

/**
 * Locker files whose audio IS this recording, however it was encoded.
 *
 * Narrows by duration first and only then compares, for the reason
 * `TrackFingerprint` documents: comparing an upload against every fingerprint in
 * the collection is not a query anyone can afford. The bucket is ±3s, the same
 * window the upload matcher uses, so a takedown and an upload agree about what
 * "the same recording" means.
 */
async function acousticMatches(
  trackId: string,
  alreadyDoomed: string[],
): Promise<{ matches: UploadStorageRef[]; available: boolean }> {
  const [catalog] = await getDb()
    .select({
      fingerprint: trackFingerprints.fingerprint,
      fingerprintDurationSec: trackFingerprints.fingerprintDurationSec,
    })
    .from(trackFingerprints)
    .where(eq(trackFingerprints.trackId, trackId))
    .limit(1);

  if (!catalog?.fingerprint.length) {
    /**
     * LOUD, not silent. Returning an empty list here is indistinguishable from
     * "no re-encode exists", and a takedown that could only compare hashes has
     * not done what a takedown is for. Tracks published through the creator path
     * carry no fingerprint row and the existing catalogue has never been
     * backfilled, so this fires for real works, not just for edge cases.
     */
    logger.warn(
      `[Takedown] No acoustic index for track ${trackId} — the locker purge could ` +
      'match byte-identical copies ONLY. A re-encode of this recording will survive ' +
      'in any locker holding one.',
    );
    return { matches: [], available: false };
  }

  const candidates = await findFingerprintCandidates(
    catalog.fingerprintDurationSec - FINGERPRINT_DURATION_WINDOW_SEC,
    catalog.fingerprintDurationSec + FINGERPRINT_DURATION_WINDOW_SEC,
    alreadyDoomed,
  );

  return {
    matches: candidates.filter(
      (candidate) =>
        candidate.fingerprint.length > 0 &&
        compareFingerprints(catalog.fingerprint, candidate.fingerprint).matched,
    ),
    available: true,
  };
}

/**
 * Delete every locker copy of a taken-down recording, bytes included.
 *
 * Three matching legs, widening from certain to acoustic:
 *
 *  - `matchedTrackId` — the file the uploader kept after Syra told them the
 *    recording was already in the catalog. A recorded identity, not a guess.
 *  - `sha256` — the same bytes in anyone else's locker, sourced from the sha of
 *    the copies the first leg found. One person's kept copy is what tells us what
 *    the offending bytes hash to; the catalog `Track` stores no checksum of its own.
 *  - Chromaprint — a re-encode of the same recording hashes differently and would
 *    survive both legs above, which for a work a rightsholder has identified is
 *    the difference between removing it and removing one encoding of it. The
 *    catalog fingerprint is compared against each locker fingerprint in the same
 *    duration bucket the upload matcher uses, with the matcher's own
 *    `compareFingerprints` — one bit-error-rate implementation, not two.
 *
 * When the catalog track has no stored fingerprint there is nothing to compare
 * against, so the acoustic leg cannot run. That is reported — logged, and carried
 * on `acousticMatchingAvailable` — rather than passed off as "found nothing":
 * only the creator-upload path is missing the fingerprint write today, and the
 * pre-existing catalogue has never been backfilled, so this is the common case
 * rather than a rarity.
 */
export async function purgeLockerCopiesOfTrack(
  trackId: string,
  deps: LockerPurgeDeps = {},
): Promise<LockerPurgeResult> {
  const linked = await findUploadsMatchedToTrack(trackId);

  const shas = [...new Set(linked.map((upload) => upload.sha256).filter(Boolean))];
  const byHash = await findUploadsBySha256(
    shas,
    linked.map((upload) => upload.id),
  );

  const doomed: UploadStorageRef[] = [...linked, ...byHash];
  const acoustic = await acousticMatches(trackId, doomed.map((upload) => upload.id));
  doomed.push(...acoustic.matches);

  if (doomed.length === 0) {
    return {
      uploadsDeleted: 0,
      objectsDeleted: 0,
      affectedOwnerIds: [],
      acousticMatchingAvailable: acoustic.available,
    };
  }

  let objectsDeleted = 0;
  for (const upload of doomed) {
    objectsDeleted += await deleteUploadStoredObjects(upload, deps);
  }

  const deletedCount = await deleteUploads(doomed.map((upload) => upload.id));

  const affectedOwnerIds = [...new Set(doomed.map((upload) => upload.ownerOxyUserId))];

  for (const ownerOxyUserId of affectedOwnerIds) {
    const fileCount = doomed.filter((upload) => upload.ownerOxyUserId === ownerOxyUserId).length;
    await announceRemoval({ ownerOxyUserId, fileCount, cause: 'takedown' }, deps);
  }

  logger.info(
    `[Takedown] Purged ${deletedCount} locker file(s) and ${objectsDeleted} stored ` +
    `object(s) for track ${trackId} across ${affectedOwnerIds.length} owner(s)`,
  );

  return {
    uploadsDeleted: deletedCount,
    objectsDeleted,
    affectedOwnerIds,
    acousticMatchingAvailable: acoustic.available,
  };
}

// ── Responsibility ────────────────────────────────────────────────────────────

/**
 * Which artist profile, if any, should carry the strike for this track.
 *
 * NOT simply `track.artistId`, and the difference is the whole reason this
 * function exists. A contributed track hangs from the profile of the artist it is
 * ATTRIBUTED to — who may be the very person the recording was taken from, and
 * who may have just claimed the profile. Striking them for a stranger's upload
 * would terminate the victim at the third offence and take down their own
 * catalog with it.
 *
 * So: if the track carries a `ContributionAttestation`, the responsible party is
 * the uploader who signed it. The strike lands on THEIR artist profile if they
 * have one, and on their ORDINARY ACCOUNT (`ContributorStanding`) if they do not
 * — which is the common case on the contribution path and used to be a dead end.
 * Without an attestation the track came through the creator path, where the
 * artist and the uploader are the same account.
 */
type Responsible =
  | { kind: 'artist'; artistId: string }
  | { kind: 'contributor'; oxyUserId: string };

async function resolveResponsible(track: { id: string; artistId: string }): Promise<Responsible> {
  const uploaderOxyUserId = await findAttestationUploader(track.id);

  if (!uploaderOxyUserId) {
    return { kind: 'artist', artistId: track.artistId };
  }

  // `type = 'artist'` is written out: `catalog_entities` holds persons in the
  // same table and they carry no `owner_oxy_user_id`, but the condition is what
  // makes that a property of the query rather than of the data.
  const [uploaderArtist] = await getDb()
    .select({ id: catalogEntities.id })
    .from(catalogEntities)
    .where(
      and(
        eq(catalogEntities.ownerOxyUserId, uploaderOxyUserId),
        eq(catalogEntities.type, 'artist')
      )
    )
    .limit(1);

  if (!uploaderArtist) {
    return { kind: 'contributor', oxyUserId: uploaderOxyUserId };
  }

  return { kind: 'artist', artistId: uploaderArtist.id };
}

/**
 * The consequences of terminating an ordinary account as a repeat infringer.
 *
 * Applied HERE rather than inside the counter, so that every path which removes
 * content stays in this module and the counter cannot recurse back into a
 * takedown. Two effects, mirroring artist termination:
 *
 *  1. Every recording this account contributed leaves the catalogue and playback,
 *     not only the one that was reported. Their attestations are the record of
 *     what they published, so they are the list.
 *  2. Their private locker is purged, documents and stored bytes.
 *
 * The second is the harsher half and is deliberate: §512(i) conditions safe
 * harbour on terminating repeat infringers' accounts, and an account whose
 * stored material is still served has not been terminated. It does destroy
 * lawful private copies along with the rest, which is worth a retention window
 * before the bytes go — see the note in the report; it is not something this
 * function should decide unilaterally.
 */
async function applyContributorTermination(
  oxyUserId: string,
  reason: string,
  deps: LockerPurgeDeps,
): Promise<LockerPurgeResult> {
  const contributedTrackIds = await findContributedTrackIds(oxyUserId);

  if (contributedTrackIds.length > 0) {
    await getDb()
      .update(tracks)
      .set({
        copyrightRemoved: true,
        isAvailable: false,
        removedAt: new Date(),
        removedReason: reason,
      })
      .where(and(inArray(tracks.id, contributedTrackIds), eq(tracks.copyrightRemoved, false)));
  }

  // Their whole locker, not only the copies of the reported work.
  const locker = await findLockerStorageRefs(oxyUserId);

  let objectsDeleted = 0;
  for (const upload of locker) {
    objectsDeleted += await deleteUploadStoredObjects(upload, deps);
  }
  const deletedCount = await deleteUploads(locker.map((upload) => upload.id));

  if (deletedCount > 0) {
    await announceRemoval(
      { ownerOxyUserId: oxyUserId, fileCount: deletedCount, cause: 'termination' },
      deps,
    );
  }

  logger.info(
    `[Takedown] Terminated contributor ${oxyUserId}: ${contributedTrackIds.length} ` +
    `contributed track(s) removed, ${deletedCount} locker file(s) and ` +
    `${objectsDeleted} stored object(s) purged`,
  );

  return {
    uploadsDeleted: deletedCount,
    objectsDeleted,
    affectedOwnerIds: deletedCount > 0 ? [oxyUserId] : [],
    // Not applicable: a termination purge takes the account's whole locker by
    // owner, so it never needs to identify recordings acoustically.
    acousticMatchingAvailable: true,
  };
}

// ── Takedown ──────────────────────────────────────────────────────────────────

/**
 * Take a track down for copyright, purge every locker copy, and strike whoever
 * published it.
 *
 * Returns `null` when the track does not exist, so the caller answers 404 rather
 * than reporting a takedown that never happened.
 */
export async function takeDownTrack(
  input: TakeDownTrackInput,
  deps: LockerPurgeDeps = {},
): Promise<TakeDownTrackResult | null> {
  const { trackId, reason, actorOxyUserId, copyrightReportId } = input;

  const [track] = await getDb()
    .select({
      id: tracks.id,
      artistId: tracks.artistId,
      copyrightRemoved: tracks.copyrightRemoved,
    })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (!track) return null;

  const alreadyRemoved = track.copyrightRemoved;

  await getDb()
    .update(tracks)
    .set({
      copyrightRemoved: true,
      isAvailable: false,
      removedAt: new Date(),
      removedReason: reason,
      removedBy: actorOxyUserId,
      ...(copyrightReportId ? { copyrightReportId } : {}),
    })
    .where(eq(tracks.id, trackId));

  const purge = await purgeLockerCopiesOfTrack(trackId, deps);

  /**
   * A replayed takedown re-runs the purge (a copy may have appeared since) but
   * never re-strikes: the strike belongs to the work, not to the number of times
   * somebody presses the button.
   */
  if (alreadyRemoved) {
    return { trackId, alreadyRemoved, strike: { applied: false, code: 'already_removed' }, purge };
  }

  const responsible = await resolveResponsible(track);

  /**
   * A contributor with no artist profile — the population the public path
   * creates, and the one that used to escape the policy entirely. Their counter
   * lives on their Oxy account instead, at the same threshold.
   */
  if (responsible.kind === 'contributor') {
    const outcome = await recordContributorStrike(responsible.oxyUserId, reason, trackId);

    if (outcome.terminated) {
      const cascade = await applyContributorTermination(responsible.oxyUserId, reason, deps);
      purge.uploadsDeleted += cascade.uploadsDeleted;
      purge.objectsDeleted += cascade.objectsDeleted;
      for (const ownerId of cascade.affectedOwnerIds) {
        if (!purge.affectedOwnerIds.includes(ownerId)) purge.affectedOwnerIds.push(ownerId);
      }
    }

    return {
      trackId,
      alreadyRemoved,
      strike: {
        applied: true,
        against: 'contributor',
        oxyUserId: responsible.oxyUserId,
        strikeCount: outcome.strikeCount,
        terminated: outcome.terminated || outcome.alreadyTerminated,
      },
      purge,
    };
  }

  const struck = await addStrike(responsible.artistId, reason, trackId);
  if (!struck) {
    return {
      trackId,
      alreadyRemoved,
      strike: { applied: false, code: 'artist_not_found' },
      purge,
    };
  }

  const terminated = struck.terminated === true;

  /**
   * Termination takes down EVERY track the artist has, in one bulk update inside
   * `strikeService`. Each of those is now a copyright-removed work, so each one's
   * locker copies have to go too — otherwise the purge obligation is met for the
   * one reported track and quietly skipped for the rest.
   */
  if (terminated) {
    const removed = await getDb()
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.artistId, responsible.artistId), eq(tracks.copyrightRemoved, true)));

    for (const removedTrack of removed) {
      const id = removedTrack.id;
      if (id === trackId) continue; // already purged above
      const extra = await purgeLockerCopiesOfTrack(id, deps);
      purge.uploadsDeleted += extra.uploadsDeleted;
      purge.objectsDeleted += extra.objectsDeleted;
      for (const ownerId of extra.affectedOwnerIds) {
        if (!purge.affectedOwnerIds.includes(ownerId)) purge.affectedOwnerIds.push(ownerId);
      }
    }
  }

  return {
    trackId,
    alreadyRemoved,
    strike: {
      applied: true,
      against: 'artist',
      artistId: responsible.artistId,
      strikeCount: struck.strikeCount,
      terminated,
    },
    purge,
  };
}
