import mongoose, { Schema, Document } from 'mongoose';

/**
 * Person - a host/guest credited on episodes (Podcasting 2.0 `<podcast:person>`).
 * Stored lightly and resolved to a Syra identity when the name/feed matches a
 * claimed Artist or Oxy user. Episodes still keep their own inline `persons[]`;
 * this collection backs cross-linking to profiles.
 */
export interface IPerson extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
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
  linkedOxyUserId: { type: String },
  linkedArtistId: { type: Schema.Types.ObjectId, ref: 'Artist' },
  img: { type: String },
  href: { type: String },
}, {
  timestamps: true,
});

PersonSchema.index({ name: 'text' });
PersonSchema.index({ linkedOxyUserId: 1 }, { sparse: true });
PersonSchema.index({ linkedArtistId: 1 }, { sparse: true });

export const PersonModel: mongoose.Model<IPerson> =
  (mongoose.models.Person as mongoose.Model<IPerson>) ??
  mongoose.model<IPerson>('Person', PersonSchema);
