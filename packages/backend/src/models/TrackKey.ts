/**
 * TrackKey — server-only AES-128 key storage.
 *
 * NEVER serialise this model to clients or include it in public API responses.
 * The authenticated key endpoint (Phase 3) is the sole reader.
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface ITrackKey extends Document {
  trackId: string;
  keyHex: string;
  keyUri: string;
  createdAt: Date;
  updatedAt: Date;
}

const TrackKeySchema = new Schema<ITrackKey>(
  {
    trackId: { type: String, required: true, unique: true, index: true },
    keyHex: { type: String, required: true },
    keyUri: { type: String, required: true },
  },
  { timestamps: true },
);

export const TrackKeyModel: mongoose.Model<ITrackKey> =
  (mongoose.models.TrackKey as mongoose.Model<ITrackKey>) ??
  mongoose.model<ITrackKey>('TrackKey', TrackKeySchema);
