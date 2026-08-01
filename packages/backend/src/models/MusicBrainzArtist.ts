import mongoose, { Schema, Document } from 'mongoose';
import type { ArtistType } from '@syra/shared-types';

/**
 * MusicBrainzArtist — the artist slice of the MusicBrainz dump, keyed by MBID.
 *
 * The same shape of thing as `IsrcRegistry`: a local, CC0 copy of a public
 * dataset, imported once and refreshed monthly, so enrichment is an indexed
 * point lookup instead of a web-service call. That is not an optimisation —
 * MusicBrainz's web service is licensed per-use for commercial callers and rate
 * limits to one request per second per IP, which cannot sit in front of an
 * upload. The dump is the only version of this that is both free and fast.
 *
 * READ-ONLY at runtime. Nothing in the application writes here; only the
 * importer does. It is a lookup table, not catalog state, which is why it is a
 * separate collection from `CatalogEntity` rather than fields on it: a Syra
 * artist is an identity we are responsible for, and this is somebody else's
 * data we happen to have a copy of.
 */
export interface IMusicBrainzArtistUrl {
  /** Relationship type as MusicBrainz names it — `official homepage`, `discogs`, `wikidata`, … */
  type: string;
  url: string;
}

export interface IMusicBrainzArtist extends Document {
  _id: mongoose.Types.ObjectId;
  mbid: string;
  name: string;
  sortName: string;
  /** `name` through the shared `normalizeNameKey` — the join key when no MBID is present. */
  nameKey: string;
  disambiguation?: string;
  artistType?: ArtistType;
  areaName?: string;
  countryCode?: string;
  /** ISO-8601, possibly partial (a bare year is normal). Stored verbatim. */
  beginDate?: string;
  endDate?: string;
  ended: boolean;
  aliases: string[];
  isni?: string;
  ipi?: string;
  urls: IMusicBrainzArtistUrl[];
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
}

const MusicBrainzArtistUrlSchema = new Schema<IMusicBrainzArtistUrl>({
  type: { type: String, required: true },
  url: { type: String, required: true },
}, { _id: false });

const MusicBrainzArtistSchema = new Schema<IMusicBrainzArtist>({
  mbid: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  sortName: { type: String, required: true },
  nameKey: { type: String, required: true, index: true },
  disambiguation: { type: String },
  artistType: {
    type: String,
    enum: ['person', 'group', 'orchestra', 'choir', 'character', 'other'],
  },
  areaName: { type: String },
  countryCode: { type: String },
  // Strings, not Dates: MusicBrainz states bare years constantly, and coercing
  // one invents a day and a month that the profile would then display as fact.
  beginDate: { type: String },
  endDate: { type: String },
  ended: { type: Boolean, default: false },
  aliases: [{ type: String }],
  isni: { type: String },
  ipi: { type: String },
  urls: [{ type: MusicBrainzArtistUrlSchema }],
}, {
  timestamps: true,
});

export const MusicBrainzArtistModel: mongoose.Model<IMusicBrainzArtist> =
  (mongoose.models.MusicBrainzArtist as mongoose.Model<IMusicBrainzArtist>) ??
  mongoose.model<IMusicBrainzArtist>('MusicBrainzArtist', MusicBrainzArtistSchema);
