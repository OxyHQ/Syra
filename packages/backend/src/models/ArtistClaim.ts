import mongoose, { Schema, Document } from 'mongoose';
import type { ArtistClaim } from '@syra/shared-types';

/**
 * ArtistClaim — somebody asking to be recognised as a contributed artist.
 *
 * A contributed artist profile is created from the tags of a file a stranger
 * uploaded, which makes it impersonation surface: the page exists, it carries a
 * real artist's name, and nobody has proven anything. So a claim NEVER
 * auto-grants. It is stored `pending` and a human resolves it; approval is what
 * writes `ownerOxyUserId` / `claimedByOxyUserId` and clears `claimable` on the
 * `CatalogEntity`.
 *
 * This is the artist twin of `claimPodcast`, with the review step that the
 * podcast flow does not need — a podcast claim is checked against the feed the
 * publisher controls, and an artist name in a file's tags proves nothing.
 */
export interface IArtistClaim
  extends Omit<ArtistClaim, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'resolvedAt'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  resolvedAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const ArtistClaimSchema = new Schema<IArtistClaim>({
  artistId: { type: String, required: true, index: true },
  oxyUserId: { type: String, required: true, index: true },
  evidence: { type: String, required: true, maxlength: 4000 },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
  resolutionNote: { type: String, maxlength: 2000 },
}, {
  timestamps: true,
});

/**
 * One OPEN claim per claimant per artist.
 *
 * Partial rather than plain unique, because the constraint is about the review
 * queue, not about history: a resubmission after a rejection is legitimate (the
 * claimant found better evidence), while two pending rows for the same pair are
 * the same request reviewed twice. Filtering on `status` keeps resolved rows out
 * of the index, so they neither block a new attempt nor get rewritten.
 */
ArtistClaimSchema.index(
  { artistId: 1, oxyUserId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

// The review queue: oldest pending first.
ArtistClaimSchema.index({ status: 1, createdAt: 1 });

export const ArtistClaimModel: mongoose.Model<IArtistClaim> =
  (mongoose.models.ArtistClaim as mongoose.Model<IArtistClaim>) ??
  mongoose.model<IArtistClaim>('ArtistClaim', ArtistClaimSchema);
