import mongoose, { Schema, Document } from 'mongoose';
import type { TrackCredit } from '@syra/shared-types';

/**
 * DiscogsRelease — the release slice of the Discogs monthly dump.
 *
 * Discogs is the fourth enrichment source because it carries what MusicBrainz is
 * thin on: per-role credits, label, catalogue number, format and country. Its
 * data dumps are CC0 with commercial use explicitly permitted.
 *
 * Its image URLs are EXCLUDED from the dump on purpose — Discogs declares the
 * discographic data public domain and the images not. That distinction is the
 * same line this whole design follows, so this model carries no image field at
 * all: there is nowhere to put one, which is the point.
 *
 * Keyed for lookup by BARCODE rather than by title, because a barcode is the
 * only strong join key an uploaded file can actually carry — `BARCODE` /
 * `UPC` tags are extracted during metadata extraction. `barcodes` is an ARRAY
 * because one release routinely lists several (UPC, EAN, and the string as
 * printed with spaces), and matching has to accept whichever one the tagger
 * happened to copy.
 *
 * READ-ONLY at runtime; only the importer writes here.
 */
export interface IDiscogsRelease extends Document {
  _id: mongoose.Types.ObjectId;
  discogsReleaseId: string;
  barcodes: string[];
  title: string;
  artistNames: string[];
  labels: string[];
  catalogNumbers: string[];
  formats: string[];
  countryCode?: string;
  /** ISO-8601, possibly partial. Stored verbatim, as the dump states it. */
  released?: string;
  credits: TrackCredit[];
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

/** Mirrors `trackCreditSchema`, so a Discogs credit is a credit with no translation. */
const DiscogsCreditSchema = new Schema<TrackCredit>({
  name: { type: String, required: true },
  role: { type: String, required: true },
  nameKey: { type: String, required: true },
  catalogEntityId: { type: String },
}, { _id: false });

const DiscogsReleaseSchema = new Schema<IDiscogsRelease>({
  discogsReleaseId: { type: String, required: true, unique: true, index: true },
  // The join key. Indexed as an array so a match on ANY of a release's barcodes
  // is one point lookup — a tagger copies whichever one was printed.
  barcodes: [{ type: String, index: true }],
  title: { type: String, required: true },
  artistNames: [{ type: String }],
  labels: [{ type: String }],
  catalogNumbers: [{ type: String }],
  formats: [{ type: String }],
  countryCode: { type: String },
  released: { type: String },
  credits: [{ type: DiscogsCreditSchema }],
}, {
  timestamps: true,
});

export const DiscogsReleaseModel: mongoose.Model<IDiscogsRelease> =
  (mongoose.models.DiscogsRelease as mongoose.Model<IDiscogsRelease>) ??
  mongoose.model<IDiscogsRelease>('DiscogsRelease', DiscogsReleaseSchema);
