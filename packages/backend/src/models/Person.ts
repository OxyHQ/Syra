import mongoose, { Schema, Document } from 'mongoose';

/**
 * Person — the canonical, GLOBAL credit identity for a host/guest, shared across
 * every show/episode they appear on (Podcasting 2.0 `<podcast:person>` + creator
 * additions).
 *
 * Dedup is by STRONG keys only:
 *  - `linkedOxyUserId` (unique, sparse) — canonical for creator-added / Oxy users.
 *  - `href` (unique, sparse) — the `<podcast:person>` URL, a stable RSS identity.
 * Name is NEVER a global merge key (avoids false "Joe Rogan" merges). RSS persons
 * that carry only a name are low-confidence: deduped by exact `nameKey` ONLY
 * among other name-only persons, never merged into/over a strong-key person.
 *
 * `linkedArtistId`/`linkedOxyUserId` are optional links, set only on a strong
 * signal (Oxy id / href), not a loose name.
 */
export interface IPerson extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  /** Lowercased/trimmed name for low-confidence (name-only) dedup. */
  nameKey?: string;
  linkedOxyUserId?: string;
  linkedArtistId?: mongoose.Types.ObjectId;
  img?: string;
  href?: string;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const PersonSchema = new Schema<IPerson>({
  name: { type: String, required: true, index: true },
  nameKey: { type: String, index: true },
  linkedOxyUserId: { type: String },
  linkedArtistId: { type: Schema.Types.ObjectId, ref: 'Artist' },
  img: { type: String },
  href: { type: String },
}, {
  timestamps: true,
});

PersonSchema.index({ name: 'text' });
// Strong dedup keys: one Person per Oxy user, one per podcast:person href.
PersonSchema.index({ linkedOxyUserId: 1 }, { unique: true, sparse: true });
PersonSchema.index({ href: 1 }, { unique: true, sparse: true });
PersonSchema.index({ linkedArtistId: 1 }, { sparse: true });

export const PersonModel: mongoose.Model<IPerson> =
  (mongoose.models.Person as mongoose.Model<IPerson>) ??
  mongoose.model<IPerson>('Person', PersonSchema);
