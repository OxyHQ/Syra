import mongoose, { Schema, Document } from 'mongoose';

/**
 * TrackFingerprint — the acoustic index of the public catalog.
 *
 * Kept OUT of `Track` on purpose. A fingerprint is thousands of int32 values, it
 * is read only by the matcher, and every catalog read already loads whole track
 * documents — carrying it inline would inflate the hot path with a payload no
 * catalog surface ever renders, and any serialiser that forgot to strip it would
 * publish it.
 *
 * `fingerprintDurationSec` is the candidate bucket, not decoration: comparing an
 * upload against every fingerprint in the catalog is not a query anyone can
 * afford, so the matcher first narrows to recordings of a comparable length and
 * only then compares bit-error rates.
 */
export interface ITrackFingerprint extends Document {
  _id: mongoose.Types.ObjectId;
  /** The `Track` this fingerprint belongs to, as a string id — same convention as every other track reference. */
  trackId: string;
  /** Chromaprint (`fpcalc`) raw fingerprint as int32 values. */
  fingerprint: number[];
  /** Seconds of audio the fingerprint was computed over. */
  fingerprintDurationSec: number;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const TrackFingerprintSchema = new Schema<ITrackFingerprint>({
  trackId: { type: String, required: true, unique: true, index: true },
  fingerprint: { type: [Number], required: true },
  fingerprintDurationSec: { type: Number, required: true },
}, {
  timestamps: true,
});

/**
 * The candidate bucket. Every match runs a range scan on this field first
 * (`duration ±3s`), so it has to be servable by an index rather than a scan.
 */
TrackFingerprintSchema.index({ fingerprintDurationSec: 1 });

export const TrackFingerprintModel: mongoose.Model<ITrackFingerprint> =
  (mongoose.models.TrackFingerprint as mongoose.Model<ITrackFingerprint>) ??
  mongoose.model<ITrackFingerprint>('TrackFingerprint', TrackFingerprintSchema);

/**
 * The ONE way a fingerprint row is written.
 *
 * Two producers fill this collection — the publish path as a track is created,
 * and the backfill script for the catalogue that predates it — and a subtle
 * disagreement between them is exactly the kind of thing that shows up months
 * later as "matching works for new tracks and not old ones". So the write lives
 * here, in the file that owns the collection, and both call it.
 *
 * An upsert keyed on `trackId`, because re-fingerprinting an already-indexed
 * track must replace its row rather than fail on the unique index — that is what
 * makes the backfill resumable and safe to re-run.
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

  await TrackFingerprintModel.updateOne(
    { trackId },
    {
      $set: {
        fingerprint: fingerprint.values,
        fingerprintDurationSec: fingerprint.durationSec,
      },
    },
    { upsert: true },
  );
  return true;
}
