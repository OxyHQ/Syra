import mongoose, { Schema, Document } from 'mongoose';

/** The kind of entity a relation graph connects. */
export type RelationKind = 'track' | 'artist';

/**
 * CatalogRelation — one precomputed relatedness edge in the collaborative graph.
 *
 * This is how Syra knows that two artists/tracks "go together": the background
 * recommendation job mines every user's listening sequence and counts how often
 * two entities are consumed in the same session. Those co-occurrence counts are
 * turned into a normalised similarity `score` (cosine-style: co-plays divided by
 * the geometric mean of each entity's own play volume, so a globally huge artist
 * does not dominate every other artist's "related" list).
 *
 * Reads are a single indexed lookup: `find({ kind, sourceId }).sort({ score:-1 })`
 * returns the related artists/tracks instantly, with no request-time aggregation.
 * The job overwrites the graph each pass, so edges are always self-consistent.
 */
export interface ICatalogRelation extends Document {
  _id: mongoose.Types.ObjectId;
  kind: RelationKind;
  sourceId: string;
  targetId: string;
  /** Normalised similarity in (0, 1]. */
  score: number;
  /** Raw co-occurrence count backing the score (for debugging/ranking ties). */
  coCount: number;
  computedAt: Date;
}

const CatalogRelationSchema = new Schema<ICatalogRelation>(
  {
    kind: { type: String, enum: ['track', 'artist'] as RelationKind[], required: true },
    sourceId: { type: String, required: true },
    targetId: { type: String, required: true },
    score: { type: Number, required: true, min: 0 },
    coCount: { type: Number, required: true, default: 0, min: 0 },
    computedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);

// Primary read: top related entities for a given source, best score first.
CatalogRelationSchema.index({ kind: 1, sourceId: 1, score: -1 });
// Upsert key: exactly one edge per (kind, source, target).
CatalogRelationSchema.index({ kind: 1, sourceId: 1, targetId: 1 }, { unique: true });

export const CatalogRelationModel: mongoose.Model<ICatalogRelation> =
  (mongoose.models.CatalogRelation as mongoose.Model<ICatalogRelation>) ??
  mongoose.model<ICatalogRelation>('CatalogRelation', CatalogRelationSchema);
