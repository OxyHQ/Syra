/**
 * The acoustic index of the public catalogue — `track_fingerprints`, on drizzle.
 *
 * Kept OUT of `tracks` on purpose. A fingerprint is thousands of int32 values,
 * it is read only by the matcher, and any serialiser that forgot to strip it
 * would publish it.
 *
 * `fingerprint_duration_sec` is the candidate bucket, not decoration: comparing
 * an upload against every fingerprint in the catalogue is not a query anyone can
 * afford, so the matcher first narrows to recordings of a comparable length
 * (`track_fingerprints_duration_idx`) and only then compares bit error rates.
 *
 * This module exists because the write used to live in `models/TrackFingerprint.ts`
 * beside the Mongoose model. Three producers call it — the publish path, ingest,
 * and the backfill script — and a subtle disagreement between them is exactly
 * what shows up months later as "matching works for new tracks and not old
 * ones", so the write stays in ONE place as it was.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { trackFingerprints } from '../schema/catalog';

/**
 * The ONE way a fingerprint row is written.
 *
 * An upsert keyed on `track_id`, because re-fingerprinting an already-indexed
 * track must replace its row rather than fail on the unique constraint — that is
 * what makes the backfill resumable and safe to re-run.
 *
 * Returns whether a row was written. An EMPTY fingerprint is refused: a row with
 * no values still matches the duration bucket, so it is returned as a candidate
 * that then compares against nothing and can never match. That is strictly worse
 * than having no row at all — the absence is honest, the empty row is a lie the
 * matcher has to keep re-examining.
 */
export async function indexTrackAcoustically(
  trackId: string,
  fingerprint: { values: number[]; durationSec: number },
): Promise<boolean> {
  if (fingerprint.values.length === 0) return false;
  if (!Number.isFinite(fingerprint.durationSec) || fingerprint.durationSec <= 0) return false;

  await getDb()
    .insert(trackFingerprints)
    .values({
      trackId,
      fingerprint: fingerprint.values,
      fingerprintDurationSec: fingerprint.durationSec,
    })
    .onConflictDoUpdate({
      target: trackFingerprints.trackId,
      set: {
        fingerprint: fingerprint.values,
        fingerprintDurationSec: fingerprint.durationSec,
      },
    });

  return true;
}

/** Whether this track already carries a fingerprint row. */
export async function hasTrackFingerprint(trackId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ trackId: trackFingerprints.trackId })
    .from(trackFingerprints)
    .where(eq(trackFingerprints.trackId, trackId))
    .limit(1);

  return row !== undefined;
}
