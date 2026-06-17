import mongoose, { Schema, Document } from 'mongoose';

/**
 * A single learned affinity weight (genre or artist) for a user. The `weight`
 * is a recency-decayed engagement score: every play/like/follow adds to it,
 * and the whole profile decays over time so stale tastes fade. Weights are not
 * normalised on write — recommendation reads sort by raw weight and normalise
 * on demand.
 */
export interface ITasteWeight {
  key: string;
  weight: number;
}

/**
 * UserTasteProfile — the per-user model of musical taste that drives
 * personalised recommendations ("Made For You", personalised radio seeds).
 *
 * It is an incrementally-maintained, recency-decayed aggregate over the user's
 * engagement signals (plays weighted by completion, likes, follows). Keeping it
 * as a compact document (top genres/artists) means personalised reads are a
 * single indexed lookup rather than an expensive scan of the event log.
 *
 * `lastDecayAt` records when global decay was last applied so the maintenance
 * pass can apply time-proportional decay idempotently.
 */
export interface IUserTasteProfile extends Document {
  _id: mongoose.Types.ObjectId;
  oxyUserId: string;
  genres: ITasteWeight[];
  artists: ITasteWeight[];
  /** Total weighted engagement observed — a maturity signal for cold-start. */
  totalSignal: number;
  lastDecayAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TasteWeightSchema = new Schema<ITasteWeight>(
  {
    key: { type: String, required: true },
    weight: { type: Number, required: true, default: 0, min: 0 },
  },
  { _id: false },
);

const UserTasteProfileSchema = new Schema<IUserTasteProfile>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    genres: { type: [TasteWeightSchema], default: [] },
    artists: { type: [TasteWeightSchema], default: [] },
    totalSignal: { type: Number, default: 0, min: 0 },
    lastDecayAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

export const UserTasteProfileModel: mongoose.Model<IUserTasteProfile> =
  (mongoose.models.UserTasteProfile as mongoose.Model<IUserTasteProfile>) ??
  mongoose.model<IUserTasteProfile>('UserTasteProfile', UserTasteProfileSchema);
