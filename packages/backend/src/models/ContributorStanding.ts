import mongoose, { Schema, Document } from 'mongoose';
import type { IStrike } from './CatalogEntity';

/**
 * ContributorStanding — the infringement record of an ORDINARY Oxy account.
 *
 * Copyright strikes have always lived on `CatalogEntity`, which works exactly as
 * long as every publisher is a registered artist. The public contribution path
 * breaks that assumption on purpose: a listener can publish a recording to the
 * catalogue without ever registering as an artist, and the entire population it
 * creates therefore had NO counter, no threshold and no termination. A takedown
 * against one of them reported `uploader_has_no_artist_profile` and stopped.
 *
 * That is not a cosmetic gap. An enforced repeat-infringer policy is a condition
 * of DMCA safe harbour, and a policy that cannot reach the accounts most likely
 * to infringe is not enforced.
 *
 * A SEPARATE collection rather than a flag on the artist, because the two are
 * different populations answering to the same policy: an artist's strikes are
 * about a catalogue they own, a contributor's are about recordings they attached
 * to somebody else's page. Merging them would mean an artist who also contributes
 * carries one blended count in which neither number means what it says. Somebody
 * who is both has a row here AND an artist profile, and each is struck for what
 * it did.
 */
export interface IContributorStanding extends Document {
  _id: mongoose.Types.ObjectId;
  /** The Oxy account this record belongs to. */
  oxyUserId: string;
  strikes: IStrike[];
  strikeCount: number;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  lastStrikeAt?: Date;
  /** Blocks the PUBLIC contribution path. The private locker is a separate question. */
  uploadsDisabled: boolean;
  terminated: boolean;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  terminatedAt?: Date;
  terminationReason?: string;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

/**
 * Deliberately the same sub-document shape as an artist's strike
 * (`CatalogEntity.IStrike`): one policy, two populations. A reviewer reading
 * either record sees the same fields, and a future change to what a strike
 * records has one shape to change rather than two that have drifted.
 */
const ContributorStrikeSchema = new Schema({
  reason: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  trackId: { type: String },
}, { _id: true });

const ContributorStandingSchema = new Schema<IContributorStanding>({
  oxyUserId: { type: String, required: true, unique: true, index: true },
  strikes: [{ type: ContributorStrikeSchema }],
  strikeCount: { type: Number, default: 0, min: 0 },
  lastStrikeAt: { type: Date },
  uploadsDisabled: { type: Boolean, default: false, index: true },
  terminated: { type: Boolean, default: false, index: true },
  terminatedAt: { type: Date },
  terminationReason: { type: String },
}, {
  timestamps: true,
});

export const ContributorStandingModel: mongoose.Model<IContributorStanding> =
  (mongoose.models.ContributorStanding as mongoose.Model<IContributorStanding>) ??
  mongoose.model<IContributorStanding>('ContributorStanding', ContributorStandingSchema);
