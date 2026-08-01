import mongoose, { Schema, Document } from 'mongoose';
import {
  Track,
  TrackMetadata,
  AudioSource,
  CatalogSource,
  ExternalIds,
  ReplayGain,
  SourceProvenance,
  TrackCredit,
  TrackImage,
  HlsRendition,
  PROVENANCE_PROVIDERS,
} from '@syra/shared-types';
import type { CatalogImageSizes } from '@syra/shared-types/track';

export interface ITrack
  extends Omit<Track, 'id' | '_id' | 'createdAt' | 'updatedAt' | 'removedAt' | 'releaseDate'>,
    Document {
  _id: mongoose.Types.ObjectId;
  /**
   * SHA-256 of the ingested audio bytes — server-only, absent from `trackSchema`.
   *
   * Dedup tier 1: the same bytes uploaded again resolve to this track in one
   * indexed point query, before the ISRC and fingerprint tiers are even tried.
   * Without it the catalog half of tier 1 is blind, and a re-upload with no ISRC
   * that is too short to fingerprint is not caught at all.
   */
  sha256?: string;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  removedAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  releaseDate?: Date;
}

const AudioSourceSchema = new Schema<AudioSource>({
  url: { type: String, required: true },
  format: { type: String, enum: ['mp3', 'flac', 'ogg', 'm4a', 'wav'], required: true },
  bitrate: { type: Number },
  duration: { type: Number },
}, { _id: false });

/**
 * Creator-editable descriptive metadata.
 *
 * No `isrc` here — `externalIds.isrc` below is the single ISRC field, and it is
 * the one carrying the sparse-unique index that makes an ISRC a dedup key. A
 * second free-text copy, writable through `PATCH /tracks/:id` and indexed by
 * nothing, could silently disagree with the identifier the catalog matches on.
 */
const TrackMetadataSchema = new Schema<TrackMetadata>({
  genre: [{ type: String }],
  bpm: { type: Number },
  key: { type: String },
  explicit: { type: Boolean, default: false },
  language: { type: String },
  copyright: { type: String },
  publisher: { type: String },
}, { _id: false });

const ExternalIdsSchema = new Schema<ExternalIds>({
  isrc: { type: String },
}, { _id: false });

const SourceProvenanceSchema = new Schema<SourceProvenance>({
  // The provenance LOG's vocabulary, wider than `CatalogSource` — it records
  // which external source supplied each field, so a claiming artist can see and
  // overwrite exactly what was filled in from outside.
  provider: { type: String, enum: PROVENANCE_PROVIDERS, required: true },
  externalId: { type: String, required: true },
  importedAt: { type: String, required: true },
  fields: [{ type: String }],
}, { _id: false });

const TrackImageSchema = new Schema<TrackImage>({
  url: { type: String, required: true },
  width: { type: Number },
  height: { type: Number },
  source: { type: String, enum: ['upload', 'cc'] as CatalogSource[] },
}, { _id: false });

const CatalogImageVariantSchema = new Schema({
  id: { type: String, required: true },
  url: { type: String, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
}, { _id: false });

const CatalogImageSizesSchema = new Schema<CatalogImageSizes>({
  small: { type: CatalogImageVariantSchema },
  medium: { type: CatalogImageVariantSchema },
  large: { type: CatalogImageVariantSchema },
  xlarge: { type: CatalogImageVariantSchema },
  xxlarge: { type: CatalogImageVariantSchema },
  original: { type: CatalogImageVariantSchema },
}, { _id: false });

const HlsRenditionSchema = new Schema<HlsRendition>({
  manifestKey: { type: String, required: true },
  bitrateKbps: { type: Number, required: true },
  encrypted: { type: Boolean, required: true },
}, { _id: false });

/**
 * A credited contributor. Mirrors `EpisodePersonSchema` — the repo already
 * resolves name credits to `CatalogEntity` rows through that shape.
 *
 * `nameKey` is indexed so "everything this person played on" is one query rather
 * than a scan; `catalogEntityId` is written only on a high-confidence match, so a
 * credit either links to the right entity or links nowhere.
 */
const TrackCreditSchema = new Schema<TrackCredit>({
  name: { type: String, required: true },
  role: { type: String, required: true },
  nameKey: { type: String, required: true },
  catalogEntityId: { type: String },
}, { _id: false });

/** ReplayGain exactly as the file declared it — captured, never measured here. */
const ReplayGainSchema = new Schema<ReplayGain>({
  trackDb: { type: Number },
  albumDb: { type: Number },
  trackPeak: { type: Number },
}, { _id: false });

const TrackSchema = new Schema<ITrack>({
  title: { type: String, required: true, index: true },
  artistId: { type: String, required: true, index: true },
  artistName: { type: String, required: true, index: true },
  albumId: { type: String, index: true },
  albumName: { type: String },
  duration: { type: Number, required: true }, // in seconds
  trackNumber: { type: Number },
  discNumber: { type: Number },
  // ── Edition facts captured from the file's tags ──────────────────────────
  // Stored as text; none of it creates an entity. `totalTracks`/`totalDiscs`
  // come from the right-hand side of TRCK/TPOS, not from counting files.
  totalTracks: { type: Number },
  totalDiscs: { type: Number },
  // A string, not a Date: TDOR is routinely a bare year, and coercing it would
  // invent a precision the file never claimed. (`releaseDate` below IS a Date —
  // the catalog owns that one.)
  originalReleaseDate: { type: String },
  catalogNumber: { type: String },
  // The LABEL owns the recording; `metadata.publisher` (TPUB) administers the
  // composition. Routinely different companies — do not merge the two fields.
  label: { type: String },
  media: { type: String },
  releaseCountry: { type: String },
  replayGain: { type: ReplayGainSchema },
  comment: { type: String },
  credits: [{ type: TrackCreditSchema }],
  audioSource: { type: AudioSourceSchema }, // optional: absent while a track is still processing
  coverArt: { type: String },
  coverArtSizes: { type: CatalogImageSizesSchema },
  metadata: { type: TrackMetadataSchema },
  // Provider-supplied descriptive metadata (genre/mood/tags)
  genre: { type: String, index: true },
  mood: { type: String, index: true },
  tags: [{ type: String, index: true }],
  releaseDate: { type: Date },
  isExplicit: { type: Boolean, default: false, index: true },
  popularity: { type: Number, default: 0, min: 0, max: 100 },
  playCount: { type: Number, default: 0 },
  favoriteCount: { type: Number, default: 0 },
  repostCount: { type: Number, default: 0 },
  primaryColor: { type: String },
  secondaryColor: { type: String },
  isAvailable: { type: Boolean, default: true, index: true },
  copyrightRemoved: { type: Boolean, default: false, index: true },
  removedAt: { type: Date },
  removedReason: { type: String },
  removedBy: { type: String }, // Oxy user ID who reported/removed
  copyrightReportId: { type: String },
  // Catalog provenance
  source: { type: String, enum: ['upload', 'cc'] as CatalogSource[], required: true, index: true },
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'ready', index: true },
  externalIds: { type: ExternalIdsSchema },
  sources: [{ type: SourceProvenanceSchema }],
  images: [{ type: TrackImageSchema }],
  hls: [{ type: HlsRenditionSchema }],
  loudnessLufs: { type: Number },
  hlsMasterKey: { type: String },
  /**
   * Content hash of the ingested audio — `select: false`, so it is server-only
   * by construction and cannot reach a client through a serializer that spreads
   * a document. Queries are unaffected: `findOne({ sha256 })` still matches.
   */
  sha256: { type: String, select: false },
}, {
  timestamps: true,
});

// Indexes for common queries
TrackSchema.index({ artistId: 1, albumId: 1 });
TrackSchema.index({ title: 'text', artistName: 'text' }); // Text search
TrackSchema.index({ popularity: -1 });
TrackSchema.index({ playCount: -1 });
TrackSchema.index({ createdAt: -1 });
// External identifier lookups
TrackSchema.index({ 'externalIds.isrc': 1 }, { unique: true, sparse: true });
// "Everything this person is credited on" — one indexed lookup, not a scan over
// every track's credits array.
TrackSchema.index({ 'credits.nameKey': 1 });
/**
 * Dedup tier 1 — the same bytes already in the catalog.
 *
 * Sparse, because every track predates the field and there is no backfill (for
 * some the source bytes are gone). Deliberately NOT unique: two catalog tracks
 * sharing bytes is a data error worth SEEING, and an `E11000` mid-ingest would
 * turn a reportable anomaly into a failed upload.
 */
TrackSchema.index({ sha256: 1 }, { sparse: true });

export const TrackModel: mongoose.Model<ITrack> =
  (mongoose.models.Track as mongoose.Model<ITrack>) ??
  mongoose.model<ITrack>('Track', TrackSchema);
