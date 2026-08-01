import mongoose, { Schema, Document } from 'mongoose';

/**
 * IsrcRegistry — a thin slice of the MusicBrainz recording dump, keyed by ISRC.
 *
 * This is how screening answers "is this a known commercial release?" without a
 * paid web service: the dumps are CC0, a few million rows import into Mongo once
 * and refresh monthly, and the lookup is a point query on `isrc`.
 *
 * An ISRC on its own is NOT evidence of anything — indie distributors assign
 * them, so an independent artist uploading their own work arrives with one. What
 * this collection adds is the resolution: an ISRC that resolves HERE, to a
 * recording with releases behind it, credited to an artist the uploader does not
 * own, is a commercial publication. That combination is the signal; the bare
 * identifier is not.
 *
 * `artistCreditNameKey` is the same normalisation artists are keyed by
 * (`nameKey`), stored at import time so artist resolution is one indexed lookup
 * rather than a normalise-everything scan.
 */
export interface IIsrcRegistry extends Document {
  _id: mongoose.Types.ObjectId;
  isrc: string;
  /** MusicBrainz recording MBID. */
  recordingMbid: string;
  title: string;
  /** The credited artist exactly as MusicBrainz writes it, joins and all. */
  artistCredit: string;
  /** `artistCredit` normalised the same way an artist's `nameKey` is. */
  artistCreditNameKey: string;
  lengthMs?: number;
  /** How many releases carry this recording — a proxy for commercial distribution. */
  releaseCount: number;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const IsrcRegistrySchema = new Schema<IIsrcRegistry>({
  isrc: { type: String, required: true, unique: true, index: true },
  recordingMbid: { type: String, required: true },
  title: { type: String, required: true },
  artistCredit: { type: String, required: true },
  artistCreditNameKey: { type: String, required: true, index: true },
  lengthMs: { type: Number },
  releaseCount: { type: Number, default: 0 },
}, {
  timestamps: true,
});

export const IsrcRegistryModel: mongoose.Model<IIsrcRegistry> =
  (mongoose.models.IsrcRegistry as mongoose.Model<IIsrcRegistry>) ??
  mongoose.model<IIsrcRegistry>('IsrcRegistry', IsrcRegistrySchema);
