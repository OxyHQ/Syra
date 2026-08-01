import mongoose, { Schema, Document } from 'mongoose';
import type {
  CatalogImageSizes,
  HlsRendition,
  LyricsLine,
  ProvenanceMarker,
  ProvenanceReport,
  RawTags,
  ReplayGain,
  TrackCredit,
  UploadAudioSource,
  UploadLyrics,
  UserUpload,
} from '@syra/shared-types';

/**
 * UserUpload — a listener's own audio file, in their own private locker.
 *
 * A SEPARATE COLLECTION from `tracks`, and that is the whole point. Catalog
 * visibility is decided by `playableTrackFilter()`, which has no owner dimension
 * and is declared invariant ("no per-user variation") — so a private file
 * written as a `Track` would be searchable, browsable, chartable and
 * recommendable from the moment it saved, and keeping it hidden would mean
 * teaching an owner check to every catalog filter, every `playableContainers`
 * pipeline and both playback gates. One omission there is somebody's private
 * music made public. Here the leak cannot happen: no catalog query reads this
 * collection.
 *
 * It also keeps the container pipelines fast (`utils/playableContainers.ts` runs
 * its `$lookup` before `$sort`/`$limit`, so it evaluates the whole collection on
 * every request — millions of locker rows in there would be fatal), and it keeps
 * storage-at-the-user's-instruction separate from distribution in the data model
 * rather than in a boolean.
 *
 * Clients never see this shape: `UserUpload` is serialised to a Track-shaped DTO
 * tagged `kind: 'upload'` (`userUploadAsTrackSchema`).
 */

export interface IUserUpload
  extends Omit<
      UserUpload,
      | 'id'
      | '_id'
      | 'createdAt'
      | 'updatedAt'
      | 'lastPlayedAt'
      | 'expiresAt'
      | 'deletionNoticeSentAt'
      | 'deletedAt'
    >,
    Document {
  _id: mongoose.Types.ObjectId;
  /**
   * Chromaprint fingerprint as raw int32 values — server-only.
   *
   * Absent from every shared DTO: it is thousands of integers per file, only the
   * matcher reads it, and exposing it would hand a client the acoustic index it
   * would need to enumerate the catalog.
   */
  fingerprint?: number[];
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  createdAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  updatedAt: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  lastPlayedAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  expiresAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  deletionNoticeSentAt?: Date;
  /** Stored as Date in MongoDB; serialised to ISO string in API responses */
  deletedAt?: Date;
}

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

const UploadAudioSourceSchema = new Schema<UploadAudioSource>({
  key: { type: String, required: true },
  format: { type: String, enum: ['mp3', 'flac', 'ogg', 'm4a', 'wav'], required: true },
}, { _id: false });

const HlsRenditionSchema = new Schema<HlsRendition>({
  manifestKey: { type: String, required: true },
  bitrateKbps: { type: Number, required: true },
  encrypted: { type: Boolean, required: true },
}, { _id: false });

const ProvenanceMarkerSchema = new Schema<ProvenanceMarker>({
  code: { type: String, required: true },
  weight: { type: String, enum: ['low', 'medium', 'high', 'blocking'], required: true },
  detail: { type: String },
}, { _id: false });

const ProvenanceReportSchema = new Schema<ProvenanceReport>({
  markers: { type: [ProvenanceMarkerSchema], default: [] },
  score: { type: Number, required: true },
  verdict: { type: String, enum: ['clean', 'suspect', 'commercial'], required: true },
}, { _id: false });

const TrackCreditSchema = new Schema<TrackCredit>({
  name: { type: String, required: true },
  role: { type: String, required: true },
  nameKey: { type: String, required: true },
  catalogEntityId: { type: String },
}, { _id: false });

const ReplayGainSchema = new Schema<ReplayGain>({
  trackDb: { type: Number },
  albumDb: { type: Number },
  trackPeak: { type: Number },
}, { _id: false });

const LyricsLineSchema = new Schema<LyricsLine>({
  timeMs: { type: Number, required: true },
  text: { type: String, required: true },
}, { _id: false });

/**
 * Lyrics from the file's own tags. Shaped like the `Lyrics` collection so
 * promoting a locker file to the catalog copies them across untranslated.
 *
 * A catalog `Track` deliberately does NOT get a field like this — `Lyrics`
 * (unique by `trackId`) is already the single authority there. A locker file has
 * no `Track` row to key that collection by, which is why it carries its own.
 */
const UploadLyricsSchema = new Schema<UploadLyrics>({
  synced: { type: Boolean, default: false },
  lines: { type: [LyricsLineSchema], default: undefined },
  plain: { type: String },
  language: { type: String },
}, { _id: false });

const RawTagsSchema = new Schema<RawTags>({
  format: { type: String },
  json: { type: String, required: true },
  truncated: { type: Boolean, required: true },
  originalByteLength: { type: Number, required: true },
}, { _id: false });

const UserUploadSchema = new Schema<IUserUpload>({
  ownerOxyUserId: { type: String, required: true, index: true },

  title: { type: String, required: true },
  /**
   * Optional on purpose. A file with no artist tag is a valid private upload —
   * the locker exists for exactly the uncatalogued material nobody else has, and
   * refusing it would refuse the files people upload a locker to preserve. The
   * PUBLIC contribution path is where an artist is mandatory, because without
   * attribution there is no claimable profile and no addressee for a takedown.
   */
  artistName: { type: String },
  /** `albumartist` — differs from `artistName` on compilations and features. */
  albumArtistName: { type: String },
  albumName: { type: String },
  /**
   * `buildAlbumKey(albumArtistName, albumName, year)`, indexed.
   *
   * The locker has NO Album collection: a private file must not create a catalog
   * container. Locker album pages are an aggregation over this field, which
   * gives the full album structure with zero catalog contamination — so this
   * index is the album page, not an optimisation of it.
   */
  albumKey: { type: String, index: true },
  trackNumber: { type: Number },
  discNumber: { type: Number },
  year: { type: Number },
  genres: [{ type: String }],
  lyrics: { type: UploadLyricsSchema },

  // ── Edition facts captured from the file's tags (same set as `Track`) ─────
  totalTracks: { type: Number },
  totalDiscs: { type: Number },
  originalReleaseDate: { type: String },
  catalogNumber: { type: String },
  label: { type: String },
  media: { type: String },
  releaseCountry: { type: String },
  replayGain: { type: ReplayGainSchema },
  comment: { type: String },
  credits: [{ type: TrackCreditSchema }],

  duration: { type: Number, required: true }, // in seconds, from ffprobe
  codec: { type: String },
  bitrateKbps: { type: Number },
  sizeBytes: { type: Number, required: true },

  sha256: { type: String, required: true, index: true },
  fingerprint: [{ type: Number }],
  fingerprintDurationSec: { type: Number },

  coverArt: { type: String },
  coverArtSizes: { type: CatalogImageSizesSchema },
  primaryColor: { type: String },
  secondaryColor: { type: String },

  audioSource: { type: UploadAudioSourceSchema },
  hls: [{ type: HlsRenditionSchema }],
  hlsMasterKey: { type: String },
  loudnessLufs: { type: Number },

  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },

  matchedTrackId: { type: String },
  resolvedArtistId: { type: String },

  lastPlayedAt: { type: Date },
  playCount: { type: Number, default: 0 },
  expiresAt: { type: Date },
  deletionNoticeSentAt: { type: Date },
  deletedAt: { type: Date },

  provenance: { type: ProvenanceReportSchema },

  /**
   * The file's native tag block — `select: false`, and that is the enforcement,
   * not a comment asking people to be careful.
   *
   * It must never reach a client. Relying on every present and future serializer
   * to remember to strip it is the kind of rule that holds until the one time it
   * does not, so the guard is mechanical: a query does not fetch this path
   * unless it explicitly asks with `.select('+rawTags')`, which means a
   * serializer that spreads a document cannot leak a field the document does not
   * contain.
   */
  rawTags: { type: RawTagsSchema, select: false },
}, {
  timestamps: true,
});

// The locker listing: one owner's files, newest first.
UserUploadSchema.index({ ownerOxyUserId: 1, createdAt: -1 });

/**
 * One copy of the same bytes per owner.
 *
 * A unique index rather than a check in the upload handler: two concurrent
 * uploads of the same file are the ordinary case (a double tap, a retried
 * request), and a read-then-write leaves exactly the window where the second one
 * lands. The `E11000` IS the duplicate detector — it answers `{ outcome:
 * 'duplicate' }` rather than being treated as an error.
 */
UserUploadSchema.index({ ownerOxyUserId: 1, sha256: 1 }, { unique: true });

/**
 * The expiry sweeper's scan.
 *
 * Deliberately NOT a Mongo TTL index. A TTL index deletes documents without
 * running any application code, which would leave every one of this file's S3
 * objects orphaned and skip the T−14d warning the retention policy promises.
 * The sweeper reads this index, then deletes storage and document together.
 */
UserUploadSchema.index({ expiresAt: 1 });

// Ingest polling: "which of my uploads are still processing / failed".
UserUploadSchema.index({ ownerOxyUserId: 1, status: 1 });

/**
 * The takedown purge's candidate bucket.
 *
 * A DMCA takedown has to reach every locker copy of the recording, including
 * RE-ENCODES, which hash differently — so that leg cannot use `sha256`. It
 * narrows by duration and then compares fingerprints, and without this index
 * that range scan reads all of `useruploads`: the one collection this design
 * expects to reach millions of rows. `TrackFingerprint` carries the same index
 * for the same reason; the locker was the asymmetric half.
 */
UserUploadSchema.index({ fingerprintDurationSec: 1 });

// One owner's locker album page: every file of one album, in disc/track order.
UserUploadSchema.index({ ownerOxyUserId: 1, albumKey: 1, discNumber: 1, trackNumber: 1 });

export const UserUploadModel: mongoose.Model<IUserUpload> =
  (mongoose.models.UserUpload as mongoose.Model<IUserUpload>) ??
  mongoose.model<IUserUpload>('UserUpload', UserUploadSchema);
