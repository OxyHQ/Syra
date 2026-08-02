/**
 * Listener uploads — the private locker, and the door to the public catalogue.
 *
 * `POST /api/uploads` is the routing brain of the whole feature. The order of its
 * steps is load-bearing, not stylistic:
 *
 *   extract → dedup → screen → route
 *
 * Dedup runs BEFORE anything is stored, because the single best outcome for a
 * file that is already in the public catalogue is that its bytes are never
 * transferred at all: the uploader gets the catalogue track added to their
 * library, which is legally the cleanest result available and costs Syra nothing.
 * Screening runs before routing because the destination decides how much evidence
 * a file needs, and a file that names its purchaser in an iTunes atom is refused
 * the public path however clean everything else looks.
 *
 * Four outcomes, and the asymmetry between two of them is deliberate:
 *
 *  - a private upload with NO resolved artist is VALID. A locker exists for
 *    exactly the uncatalogued, badly-tagged material people want to preserve, and
 *    refusing it would refuse the reason the locker exists.
 *  - a public contribution with no resolved artist is REJECTED, explicitly, with
 *    a machine-readable code — never silently downgraded to the locker. Without
 *    an artist there is no attribution, no profile for the real artist to claim,
 *    and nobody to address a takedown to; the uploader is told what the file is
 *    missing rather than having their stated intent quietly changed.
 *
 * The locker never becomes catalogue by accident: `UserUpload` is a separate
 * collection, no catalogue query reads it, and the DTO that leaves this file
 * ({@link toUploadTrackDto}) carries no S3 key — not the source object, not the
 * HLS manifests. The only way to hear a locker file is
 * `GET /api/uploads/:id/stream`, whose owner check is part of the query that
 * loads the document rather than a branch after it.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import multer from 'multer';
import sharp from 'sharp';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  buildAlbumKey,
  isDenylistedAlbumName,
  normalizeIsrc,
  uploadTrackRequestSchema,
  updateUserUploadRequestSchema,
  type AudioFormat,
  type UploadBlockedReason,
  type UploadOutcome,
  type UserUploadAsTrack,
} from '@syra/shared-types';

import { env } from '../config/env';
import { getS3LockerAudioKey } from '../config/s3.config';
import { UserUploadModel, type IUserUpload } from '../models/UserUpload';
import { TrackModel } from '../models/Track';
import { TrackKeyModel } from '../models/TrackKey';
import { indexTrackAcoustically } from '../models/TrackFingerprint';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { ImageAssetModel } from '../models/ImageAsset';
import { ArtistModel } from '../models/CatalogEntity';
import { AlbumModel } from '../models/Album';

import {
  extractMetadata,
  type ExtractedMetadata,
  type ExtractedPicture,
} from '../services/uploads/extractMetadata';
import { fingerprintFile, type Fingerprint } from '../services/uploads/fingerprint';
import { identifyRecording, type AcousticIdentity } from '../services/uploads/acoustid';
import { discoverIsrc, verifyIsrcClaim, type IsrcRecording } from '../services/uploads/isrcLookup';
import {
  collectProvenanceSignals,
  type ProvenanceContext,
  type ScreeningReport,
} from '../services/uploads/provenanceSignals';
import { matchCatalog } from '../services/uploads/matchCatalog';
import { ensureContributedArtist, resolveArtist } from '../services/uploads/resolveArtist';
import {
  classifyAlbumType,
  ensureContributedAlbum,
  resolveAlbum,
} from '../services/uploads/resolveAlbum';
import { evaluatePublicContribution } from '../services/compliance/contributionPolicy';
import { deleteUploadStoredObjects } from '../services/compliance/takedown';
import { computeUploadExpiry, recordUploadPlay } from '../services/uploads/expirySweeper';

import { uploadToS3, streamFromS3 } from '../services/s3Service';
import { uploadTrackAudio } from '../services/audioStorageService';
import { enqueueIngest, enqueueUploadIngest } from '../services/ingest/ingestQueue';
import { LOCKER_HLS_BITRATES_KBPS } from '../services/ingest/hlsPackager';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';
import { buildMasterPlaylistFor, buildVariantPlaylistFor } from '../services/stream/manifestService';

import { isDatabaseConnected } from '../utils/database';
import { logger } from '../utils/logger';
import { getErrorMessage, getErrorStack } from '../utils/error';
import { getParam, parseBoundedLimit, parseOffset } from '../utils/reqParams';
import { isDuplicateKeyOn } from '../utils/duplicateKey';
import { normalizeImageRef } from '../utils/musicHelpers';
import { getStoredImageColors } from '../utils/imageColors';
import { storeImageAsset } from '../services/imageAssetService';

// ── Constants ────────────────────────────────────────────────────────────────

const CONTENT_TYPE_OCTET_STREAM = 'application/octet-stream';
const CONTENT_TYPE_HLS_PLAYLIST = 'application/vnd.apple.mpegurl';
const CACHE_CONTROL_NO_STORE = 'no-store';
const CACHE_CONTROL_PRIVATE_SHORT = 'private, max-age=300';

/** Same session length as catalogue playback: play, pause, resume on one token. */
const LOCKER_STREAM_SESSION_TTL_SEC = 3600;

/**
 * The bitrate cap for a locker stream is the locker ladder itself — the user's
 * subscription entitlement is deliberately NOT applied here.
 *
 * Entitlement gates CATALOGUE quality, which is Syra's distribution of somebody
 * else's recording. A locker file is the listener's own upload, stored at their
 * instruction, and there is nothing to upsell them to: the ladder has one rung.
 * Applying the catalogue cap would also mean a data-saver listener (forced to
 * 96 kbps) received a master playlist with no renditions at all — their own file,
 * silently unplayable.
 */
const LOCKER_MAX_BITRATE_KBPS = Math.max(...LOCKER_HLS_BITRATES_KBPS);

/** Matches the creator upload cap: a 5-minute FLAC is ~30MB, a long one far more. */
const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;

const AUDIO_MIME_TO_FORMAT: Readonly<Record<string, AudioFormat>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg3': 'mp3',
  'audio/x-mpeg-3': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * Disk storage, not memory: `ffprobe`, `fpcalc` and `music-metadata` all want a
 * path, and a 200MB Buffer per in-flight request does not survive consumer upload
 * volume. Multer removes its own temp file when the multipart parse fails; every
 * path after a successful parse is cleaned up in the handler's `finally`.
 */
const lockerUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIME_TO_FORMAT[file.mimetype]) {
      cb(null, true);
      return;
    }
    cb(new Error('Invalid file type. Only audio files (mp3, flac, ogg, m4a, wav) are allowed.'));
  },
}).single('audioFile');

interface AudioUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

// ── Serialisation ────────────────────────────────────────────────────────────

/**
 * A locker file in the catalogue's Track shape, tagged `kind: 'upload'`.
 *
 * The boundary this function IS: every storage key stays behind it. The stored
 * record carries `audioSource.key`, `hlsMasterKey` and one `manifestKey` per
 * rendition — raw S3 object names — and none of them appear in the result. A
 * locker file is reachable only through `GET /api/uploads/:id/stream`, which
 * checks ownership; handing a client the key would be handing it a way around
 * that check the day the bucket policy is loosened by anyone, for any reason.
 *
 * `artistId` and `artistName` fall back to `''` rather than being omitted: the
 * shared Track shape requires both, an unresolved artist is a normal state for a
 * locker file, and the UI renders its own "Unknown artist" for an empty name so
 * the backend never ships a language-specific string.
 */
export function toUploadTrackDto(upload: IUserUpload): UserUploadAsTrack {
  return {
    kind: 'upload',
    id: upload._id.toString(),
    title: upload.title,
    artistId: upload.resolvedArtistId ?? '',
    artistName: upload.artistName ?? '',
    albumName: upload.albumName,
    // The locker has NO Album collection; album views are a grouping over this
    // key. Without it on the wire the client has to re-derive the grouping from
    // display names, which splits a compilation across its guest artists and
    // merges two same-titled releases from different years.
    albumKey: upload.albumKey,
    albumArtistName: upload.albumArtistName,
    duration: upload.duration,
    trackNumber: upload.trackNumber,
    discNumber: upload.discNumber,
    coverArt: normalizeImageRef(upload.coverArt),
    coverArtSizes: upload.coverArtSizes,
    metadata: upload.genres?.length ? { genre: [...upload.genres] } : undefined,
    // The locker stores no advisory flag; a private file is not rated by anyone.
    isExplicit: false,
    // A soft-deleted file is past its expiry and no longer playable, so it
    // reports the same unavailability a taken-down track would.
    isAvailable: !upload.deletedAt,
    source: 'upload',
    status: upload.status,
    playCount: upload.playCount,
    primaryColor: upload.primaryColor,
    secondaryColor: upload.secondaryColor,
    /**
     * When this file is due for deletion.
     *
     * User-facing, not bookkeeping: retention promises the owner a warning before
     * anything is removed, and a warning the client cannot render is not a
     * warning. The other retention stamps (`deletionNoticeSentAt`, `deletedAt`)
     * stay server-side — they are how the sweeper tracks its own work.
     */
    expiresAt: upload.expiresAt?.toISOString(),
    createdAt: upload.createdAt.toISOString(),
    updatedAt: upload.updatedAt.toISOString(),
  };
}

// ── Request parsing ──────────────────────────────────────────────────────────

/**
 * Multipart carries every field as a string, so numbers, booleans and lists have
 * to be recovered before the shared schema sees them.
 *
 * Recovered, not coerced away: a `trackNumber` of `"side b"` becomes `NaN` and
 * fails the schema loudly, rather than being dropped and leaving the uploader
 * wondering where their track number went.
 */
function normalizeMultipartFields(body: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...body };

  for (const key of ['trackNumber', 'discNumber', 'year'] as const) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim() !== '') {
      normalized[key] = Number(value);
    }
  }

  if (typeof normalized.isExplicit === 'string') {
    normalized.isExplicit = normalized.isExplicit === 'true';
  }

  if (typeof normalized.genres === 'string') {
    normalized.genres = normalized.genres
      .split(',')
      .map((genre) => genre.trim())
      .filter(Boolean);
  }

  return normalized;
}

/** An uploader-supplied override wins over the file's tags; absent keeps the tag. */
function preferOverride(override: string | undefined, extracted: string | undefined): string | undefined {
  const trimmed = override?.trim();
  return trimmed ? trimmed : extracted;
}

// ── Acoustic identification ──────────────────────────────────────────────────

/**
 * Ask AcoustID what recording this audio is, when there is anything to ask
 * about. Shared by the two paths that publish — the direct upload and the
 * promote — so the precondition is stated once.
 *
 * No fingerprint means no question to put: `fpcalc` produces nothing at all
 * below about 2.6 s and fails on some inputs outright, and spending a request on
 * an empty fingerprint would burn budget to be told nothing.
 *
 * `undefined` — no fingerprint, no key, no budget, service down, or nothing
 * above the score threshold — leaves every existing refusal exactly as it was.
 */
async function identifyForPublication(
  fingerprint: Fingerprint | undefined,
): Promise<AcousticIdentity | undefined> {
  if (!fingerprint) return undefined;
  return identifyRecording(fingerprint);
}

/**
 * Tier 3 of identification: the ISRC the UPLOADER supplied, checked against the
 * file they uploaded.
 *
 * The tier order is a precedence of evidence, and it runs strictly downhill:
 *
 *  1. the file's own `TSRC`/`ISRC` tag — the recording's own declaration;
 *  2. the acoustic match — what the audio itself resolves to;
 *  3. this — what a person typed into a text box.
 *
 * Which is why the first thing this does is stand down. An ISRC already
 * identified by either tier above ENDS the question: a file that declares a code
 * is not overridden by a typed one, and a disagreement between the two is
 * evidence about the file rather than a correction to it. It is logged and the
 * declared code stands.
 *
 * When the claim IS consulted, it is never simply believed. The only reason this
 * tier can exist at all is that `verifyIsrcClaim` can refuse it: an accepted
 * fabrication would put a stranger's recording identifier on a track, which
 * `resolveArtist` tier 1 turns into a HIGH-confidence link to that stranger's
 * artist profile — a wrong link is an accusation, and one nothing downstream can
 * tell from a right one.
 *
 * Returns the recording on acceptance (its facts fill the gaps the file left),
 * nothing when there is no claim to consider, and a refusal otherwise.
 */
async function verifyClaimedIsrc(params: {
  /** What the uploader typed, already normalised and format-checked by the schema. */
  claimed: string | undefined;
  /** What tiers 1 and 2 produced, if anything. */
  identified: string | undefined;
  metadata: ExtractedMetadata;
  report: ScreeningReport;
}): Promise<
  | { accepted: true; recording?: IsrcRecording }
  | { accepted: false; status: number; outcome: UploadOutcome }
> {
  const { claimed, identified, metadata, report } = params;
  if (!claimed) return { accepted: true };

  if (identified) {
    // Compared through the shared normaliser, because a `TSRC` frame is free to
    // carry the hyphenated spelling the code is printed in — and reporting
    // `ES-A09-26-07944` as contradicting `ESA092607944` would be a fabricated
    // disagreement in the one record anybody would consult about a real one.
    if (normalizeIsrc(identified) !== claimed) {
      logger.info('[uploads] the uploader supplied an ISRC that the file already contradicts', {
        identified: normalizeIsrc(identified),
        claimed,
      });
    }
    return { accepted: true };
  }

  const refuse = (code: UploadBlockedReason, message: string) => ({
    accepted: false as const,
    status: 422,
    outcome: { outcome: 'blocked' as const, code, message, markers: report.markers },
  });

  const verdict = await verifyIsrcClaim(claimed, {
    // `ffprobe`'s measurement, which is the one input to this decision that
    // nobody typed — see `ISRC_DURATION_TOLERANCE_SEC`.
    durationSec: metadata.technical.durationSec,
    // The FILE's own tags, never the uploader's override fields: a value typed
    // on the same form as the claim is the same person asserting the same thing
    // twice, and corroborates nothing.
    title: metadata.title,
    artistName: metadata.artistName,
    albumArtistName: metadata.albumArtistName,
  });

  if (verdict.status === 'unverifiable') {
    logger.info('[uploads] a supplied ISRC could not be checked', {
      claimed,
      reason: verdict.reason,
    });
    return refuse(
      'isrc_unverifiable',
      `${claimed} could not be found in any recording database, so there is nothing to ` +
        'check it against. Confirm the code with whoever registered the recording, or keep ' +
        'the file in your private library instead.',
    );
  }

  if (verdict.status === 'mismatch') {
    /**
     * Naming what disagreed is what separates a mistyped character from a code
     * copied off the wrong row of a distributor's catalogue — two different
     * mistakes with two different fixes. The name half is reported as the pair
     * it was tested as ("title or artist"), because either one alone would have
     * satisfied the rule, so neither one alone is what failed.
     */
    const disagreed = verdict.disagreed.includes('duration') ? ['length'] : [];
    const names = verdict.disagreed.filter((field) => field !== 'duration');
    if (names.length > 0) disagreed.push(names.join(' or '));

    const registered = [verdict.recording.title, verdict.recording.artistName]
      .filter(Boolean)
      .join(' — ');

    return refuse(
      'isrc_mismatch',
      `${claimed} belongs to a different recording — ` +
        `${registered || 'one this file does not match'}, ` +
        `${Math.round(verdict.recording.durationSec)} seconds long. It disagrees with ` +
        `this file's ${disagreed.join(' and ')}. Check the code, or keep the file in your ` +
        'private library instead.',
    );
  }

  return { accepted: true, recording: verdict.recording };
}

/**
 * The identification as the provenance scorer reads it.
 *
 * Only the evidence half travels: the scorer is told what the recording IS and
 * how widely it was released, and never the identifiers recovered from it. What
 * the audio proves and what we then fill into the file's gaps are two different
 * facts, and merging them would let this feature manufacture evidence against an
 * uploader — a file whose MusicBrainz ids WE supplied would score as "tagged
 * against MusicBrainz", a marker that is supposed to mean the uploader's tagger
 * did it.
 */
function acousticEvidence(
  identity: AcousticIdentity | undefined,
): Pick<ProvenanceContext, 'acousticIdentityMatch'> {
  if (!identity) return {};
  return {
    acousticIdentityMatch: {
      recordingMbid: identity.recordingMbid,
      score: identity.score,
      title: identity.title,
      artistName: identity.artistName,
      releaseCount: identity.releaseCount,
    },
  };
}

// ── Embedded artwork ─────────────────────────────────────────────────────────

/**
 * Below this, an embedded image is stored and shown in the owner's own library
 * but is NOT promoted to catalog cover art.
 *
 * Plenty of files carry a 200×200 thumbnail that looks fine in a tag editor and
 * blurry on an album page. Promoting one is not reversible in practice — it
 * becomes the artwork every listener sees, and nothing later knows it was a
 * thumbnail.
 *
 * 300, lowered from 500 deliberately. The floor is a QUALITY judgement, not a
 * correctness one, and 500 was refusing real releases: a distributor-embedded
 * 300×300 front cover is what a legitimate rights-holder's own file commonly
 * carries, and rejecting it pushed them toward copying artwork from a streaming
 * service's CDN — which is the one thing that is genuinely not ours to take.
 * Better a slightly soft cover the uploader owns than a sharp one they do not.
 */
const MIN_CATALOG_COVER_ART_PX = 300;

/**
 * Picture types that are a PERSON, not a release.
 *
 * ID3 and FLAC both carry a type byte, and `0x07`/`0x08`/`0x0A` mean soloist,
 * artist and band. Those must never be auto-published: turning "a photo that
 * happened to be in this MP3" into an artist profile picture puts uploaded
 * content on a page across the whole site, which is a different act from
 * attaching cover art to the release it belongs to.
 */
const ARTIST_PICTURE_TYPE_KEYWORDS = [
  'artist',
  'performer',
  'soloist',
  'band',
  'orchestra',
  'conductor',
  'composer',
  'lyricist',
];

/**
 * The one picture that is this release's front cover, or nothing.
 *
 * Never falls back to an arbitrary picture: a back cover, a disc face or a band
 * photo are all real picture types and none of them is the artwork. The untyped
 * case is the M4A container, which carries a bare list with no type enum at all,
 * so its first image is the cover by convention.
 */
function selectEmbeddedCoverArt(pictures: ExtractedPicture[]): ExtractedPicture | undefined {
  const front = pictures.find((picture) => picture.type?.toLowerCase().includes('front'));
  if (front) return front;
  return pictures.find((picture) => !picture.type);
}

/** True for a picture whose declared type is a person rather than a release. */
export function isArtistPicture(picture: ExtractedPicture): boolean {
  const type = picture.type?.toLowerCase() ?? '';
  return ARTIST_PICTURE_TYPE_KEYWORDS.some((keyword) => type.includes(keyword));
}

/**
 * May an ALREADY-STORED image be used as catalog artwork?
 *
 * Asked on the promote path, where the cover was stored when the file entered
 * the locker and its dimensions are recorded rather than re-measured. An image
 * with no recorded dimensions is treated as ineligible: unknown is not a reason
 * to promote something to a page everybody sees.
 */
async function isCatalogEligibleImage(imageId: string | undefined): Promise<boolean> {
  if (!imageId) return false;
  const asset = await ImageAssetModel.findById(imageId).select('width height').lean();
  return (
    asset?.width !== undefined &&
    asset.height !== undefined &&
    asset.width >= MIN_CATALOG_COVER_ART_PX &&
    asset.height >= MIN_CATALOG_COVER_ART_PX
  );
}

interface StoredCoverArt {
  /** ImageAsset id — the only form cover art is ever referenced by. */
  imageId: string;
  width?: number;
  height?: number;
  /** Whether it clears {@link MIN_CATALOG_COVER_ART_PX} and may become catalog artwork. */
  catalogEligible: boolean;
}

/**
 * Store a file's embedded front cover as an image asset.
 *
 * Returns undefined — never throws — when the file carries no usable cover or
 * the bytes will not decode: artwork is the least important thing about an
 * upload, and losing a whole upload because its APIC frame was malformed would
 * be a bad trade.
 */
async function storeEmbeddedCoverArt(
  metadata: ExtractedMetadata,
  uploaderOxyUserId: string,
): Promise<StoredCoverArt | undefined> {
  const picture = selectEmbeddedCoverArt(metadata.pictures);
  if (!picture || isArtistPicture(picture)) return undefined;

  try {
    const probed = await sharp(picture.data).metadata();
    const { width, height } = probed;
    const stored = await storeImageAsset({
      buffer: picture.data,
      filename: `cover.${probed.format ?? 'jpg'}`,
      contentType: picture.mimeType,
      ownerType: 'upload',
      uploadedBy: uploaderOxyUserId,
      width,
      height,
    });

    return {
      imageId: stored.id,
      width,
      height,
      catalogEligible:
        width !== undefined &&
        height !== undefined &&
        width >= MIN_CATALOG_COVER_ART_PX &&
        height >= MIN_CATALOG_COVER_ART_PX,
    };
  } catch (err) {
    logger.warn('[uploads] could not store embedded cover art', {
      message: getErrorMessage(err),
    });
    return undefined;
  }
}

// ── Access ───────────────────────────────────────────────────────────────────

type UploadAccess =
  | { ok: true; ownerOxyUserId: string; maxBitrateKbps: number }
  | { ok: false };

/**
 * Who is asking for this locker file's media, by session or by stream token.
 *
 * The identity it returns is used as a QUERY FILTER, never as a comparison after
 * the fact — every loader below finds the document by `{ _id, ownerOxyUserId }`
 * together. A wrong owner therefore produces "not found", which is also the right
 * answer for privacy: a stranger must not be able to tell a locker id apart from
 * a nonexistent one.
 *
 * A stream token is bound to its subject id at mint time, so a token minted for a
 * catalogue track cannot authorise an upload (different ObjectId), and a token
 * minted for somebody else's upload carries their user id and therefore matches
 * no document of this caller's.
 */
function resolveUploadAccess(req: AuthRequest, uploadId: string): UploadAccess {
  const rawToken = req.query?.t;
  if (typeof rawToken === 'string' && rawToken) {
    const claims = verifyStreamToken(rawToken);
    if (claims && claims.trackId === uploadId && claims.userId) {
      return {
        ok: true,
        ownerOxyUserId: claims.userId,
        maxBitrateKbps: claims.maxBitrateKbps,
      };
    }
  }

  if (req.user?.id) {
    return { ok: true, ownerOxyUserId: req.user.id, maxBitrateKbps: LOCKER_MAX_BITRATE_KBPS };
  }

  return { ok: false };
}

/** Load a live (not soft-deleted) locker file that belongs to this owner. */
async function findOwnedUpload(
  uploadId: string,
  ownerOxyUserId: string,
): Promise<IUserUpload | null> {
  return UserUploadModel.findOne({
    _id: uploadId,
    ownerOxyUserId,
    deletedAt: null,
  }).exec();
}

// ── Storage ──────────────────────────────────────────────────────────────────

interface StoredLocker {
  stored: IUserUpload;
}

interface DuplicateLocker {
  duplicateUploadId: string;
}

interface StoreLockerParams {
  ownerOxyUserId: string;
  metadata: ExtractedMetadata;
  overrides: {
    title?: string;
    artistName?: string;
    albumName?: string;
    trackNumber?: number;
    discNumber?: number;
    year?: number;
    genres?: string[];
    coverArt?: string;
  };
  format: AudioFormat;
  filePath: string;
  /**
   * The name the uploader's file actually had.
   *
   * NOT derivable from `filePath`: multer writes to a temp path whose basename is
   * a random hash, so falling back to it gives an untagged file a title like
   * `0a89647fda60ee8d18086f7a73180de7`. The original name is the only
   * human-meaningful thing left when a file carries no title tag at all — which
   * is exactly the material a locker exists for.
   */
  originalName: string;
  fingerprint?: Fingerprint;
  report: ScreeningReport;
  resolvedArtistId?: string;
}

/**
 * Persist a locker file: document first, then bytes, then ingest.
 *
 * The document goes first because the `{ownerOxyUserId, sha256}` unique index IS
 * the duplicate detector — a read-then-write leaves exactly the window a double
 * tap lands in — and losing that race before any bytes move means no orphaned S3
 * object to clean up. If the upload to S3 then fails, the document is removed
 * again rather than being left pointing at a key that holds nothing.
 */
async function storeLockerUpload(
  params: StoreLockerParams,
): Promise<StoredLocker | DuplicateLocker> {
  const { ownerOxyUserId, metadata, overrides, format, filePath, fingerprint, report } = params;

  const uploadId = new mongoose.Types.ObjectId();
  const now = new Date();
  const audioKey = getS3LockerAudioKey(ownerOxyUserId, uploadId.toString(), format);

  const coverArtColors = overrides.coverArt
    ? await getStoredImageColors(overrides.coverArt)
    : undefined;

  const document = new UserUploadModel({
    _id: uploadId,
    ownerOxyUserId,

    // `??` for the tag (absent means absent), `||` for the filename (a file
    // called `.mp3` parses to an empty name, which is not a title).
    title:
      preferOverride(overrides.title, metadata.title) ??
      (path.parse(params.originalName).name.trim() || 'Untitled'),
    artistName: preferOverride(overrides.artistName, metadata.artistName),
    albumArtistName: metadata.albumArtistName,
    albumName: preferOverride(overrides.albumName, metadata.albumName),
    /**
     * Only a file that names a release belongs to one.
     *
     * `buildAlbumKey` is a pure join and answers `"||"` for a file with no tags
     * at all — a non-empty string, so a naive "has an album key" filter groups
     * every untagged upload in the locker into one phantom album. Absence of an
     * album name is absence of an album.
     */
    albumKey: preferOverride(overrides.albumName, metadata.albumName)
      ? buildAlbumKey({
          albumArtistName:
            metadata.albumArtistName ?? preferOverride(overrides.artistName, metadata.artistName),
          albumName: preferOverride(overrides.albumName, metadata.albumName),
          year: overrides.year ?? metadata.year,
        })
      : undefined,
    trackNumber: overrides.trackNumber ?? metadata.trackNumber,
    discNumber: overrides.discNumber ?? metadata.discNumber,
    year: overrides.year ?? metadata.year,
    genres: overrides.genres?.length ? overrides.genres : metadata.genres,

    duration: metadata.technical.durationSec,
    codec: metadata.technical.codec,
    bitrateKbps: metadata.technical.bitrateKbps,
    sizeBytes: metadata.sizeBytes,

    sha256: metadata.sha256,
    fingerprint: fingerprint?.values,
    fingerprintDurationSec: fingerprint?.durationSec,

    coverArt: overrides.coverArt,
    primaryColor: coverArtColors?.primaryColor,
    secondaryColor: coverArtColors?.secondaryColor,

    audioSource: { key: audioKey, format },
    status: 'processing',

    /**
     * The file's own tags, verbatim.
     *
     * This is the audit record: months later a DMCA claim is answered by what the
     * file DECLARED at upload time, and nothing else preserves that — the
     * normalized fields above are a lossy view, and the source object may be
     * gone. `select: false` on the model keeps it off every read that does not
     * ask for it, so it never reaches a client.
     */
    rawTags: metadata.rawTags,

    resolvedArtistId: params.resolvedArtistId,

    playCount: 0,
    expiresAt: computeUploadExpiry({ createdAt: now }),
    provenance: report,
  });

  let saved: IUserUpload;
  try {
    saved = await document.save();
  } catch (err) {
    // Losing the race on THIS owner's copy of THESE bytes is the duplicate
    // outcome. Named rather than a bare 11000 check: a collision on any other
    // index is a bug, and recovering from it as "you already have this file"
    // would answer with somebody else's row or silently drop the write.
    if (!isDuplicateKeyOn(err, 'ownerOxyUserId', 'sha256')) throw err;
    const existing = await UserUploadModel.findOne({ ownerOxyUserId, sha256: metadata.sha256 })
      .select('_id')
      .lean();
    if (!existing) throw err;
    return { duplicateUploadId: existing._id.toString() };
  }

  try {
    // Streamed from the temp file: the S3 client derives Content-Length from the
    // ReadStream's path, so a 200MB upload is never held in memory.
    await uploadToS3(audioKey, fs.createReadStream(filePath), {
      contentType: `audio/${format}`,
    });
  } catch (err) {
    await UserUploadModel.deleteOne({ _id: uploadId }).catch((cleanupErr: unknown) =>
      logger.error('[uploads] failed to roll back locker row after S3 failure', {
        uploadId: uploadId.toString(),
        err: cleanupErr,
      }),
    );
    throw err;
  }

  await enqueueUploadIngest(uploadId.toString());

  return { stored: saved };
}

// ── The public gate ──────────────────────────────────────────────────────────

type PublicGateResult =
  | { allowed: true; artistId: string; artistName: string; requiresAttestation: boolean }
  | { allowed: false; status: number; outcome: UploadOutcome };

/**
 * Everything that has to be true before a file is published to the public
 * catalogue, in one place, used by both the direct upload and the promote path.
 *
 * The order is the order of increasing cost and decreasing certainty:
 * a placeholder artist name is refused without touching the database, then the
 * artist is resolved, then the contribution matrix decides, then screening, then
 * the attestation. None of it is re-derived here — the matrix is asked, never
 * reimplemented, and the denylist predicate is the shared one.
 */
async function screenPublicContribution(params: {
  uploaderOxyUserId: string;
  metadata: ExtractedMetadata;
  declaredArtistName?: string;
  fileName?: string;
  /** Relative path within a multi-file upload — tier 7 of artist resolution. */
  relativePath?: string;
  /**
   * A catalogue recording this audio matched acoustically WITHOUT being a dedup
   * hit — the copy is removed or unavailable. Tier 3 of artist resolution, and
   * the strongest provenance signal there is when the match is a takedown.
   */
  acoustic?: { artistId: string; artistName: string };
  attestation?: string;
  /**
   * Image asset id for the ARTIST's photo, supplied by the uploader. Consumed
   * only when the target profile has none — see the refusal below.
   */
  report: ScreeningReport;
  /**
   * What the fingerprint resolved to, when it resolved to anything.
   *
   * Consumed only to FILL what the file did not say. Its identifiers are strong
   * — they come from one MusicBrainz record rather than from a tagger — but a
   * value the file states is the uploader's own declaration and stays theirs.
   */
  identity?: AcousticIdentity;
  /**
   * The recording the uploader's own ISRC resolved to, once it was CHECKED
   * against the audio (see `verifyClaimedIsrc`). Tier 3, so it is consulted only
   * where the file's tag and the acoustic match both said nothing — and, like
   * the acoustic identity, only ever to fill a gap.
   */
  verifiedIsrc?: IsrcRecording;
}): Promise<PublicGateResult> {
  const { metadata, report, identity, verifiedIsrc } = params;

  const refuse = (
    status: number,
    code: UploadBlockedReason,
    message: string,
  ): PublicGateResult => ({
    allowed: false,
    status,
    outcome: { outcome: 'blocked', code, message, markers: report.markers },
  });

  /**
   * Screening first, before anything is written.
   *
   * A file that names its purchaser or its store is refused whoever is uploading
   * it and whatever the matrix would have said — `commercial` is reached by a
   * single blocking marker on its own, independently of the score. Running it
   * ahead of resolution is not just cheaper: `ensureContributedArtist` CREATES a
   * claimable profile, and a refused upload must not leave one behind.
   */
  if (report.verdict === 'commercial') {
    return refuse(
      403,
      'commercial_provenance',
      'This file looks like a commercial release, so it cannot be published to the ' +
        'public catalogue. You can still keep it in your private library.',
    );
  }

  const resolution = await resolveArtist({
    // Tier 1, from whichever tier of identification produced a code — the file's
    // own tag, the acoustic match, or the uploader's verified claim, in that
    // order of precedence.
    isrc: metadata.isrc ?? identity?.isrc ?? verifiedIsrc?.isrc,
    // Tier 4. The file's own `MUSICBRAINZ_ARTISTID` when it has one, otherwise
    // the artist the acoustic match named — and the NAME beside it, because that
    // tier deliberately refuses to stand on an identifier alone ("a name is
    // still needed to create anything"). Both halves come from the same
    // MusicBrainz record, so supplying them together is what makes the tier
    // reachable for a file that names nobody, which is the case it was written
    // for and could not previously serve.
    musicbrainzArtistId: metadata.musicbrainz.artistId ?? identity?.musicbrainzArtistId,
    artistName:
      params.declaredArtistName ??
      metadata.artistName ??
      identity?.artistName ??
      verifiedIsrc?.artistName,
    albumArtistName: metadata.albumArtistName,
    // Tier 3. The one signal that can name an artist for a file carrying no
    // usable tags at all, which is exactly the case the chain exists for.
    fingerprintMatch: params.acoustic,
    fileName: params.fileName,
    relativePath: params.relativePath,
  });

  /**
   * Only `linkedArtistId` is an identity, and the resolver populates it at HIGH
   * confidence alone. Below that the chain has a NAME, not an artist, and the
   * name is taken to `ensureContributedArtist` — which finds the existing profile
   * for that name key if there is one (so a claimed artist reaches the matrix as
   * case B rather than gaining a duplicate stub beside them) and otherwise
   * creates the claimable stub that case C describes.
   *
   * `null` back from it means the name is a tagger's placeholder. That is its own
   * refusal, not "no artist": a `Various Artists` stub is how a catalog fills with
   * rubbish that no later write can merge away.
   */
  let artistId =
    resolution.confidence === 'high' ? resolution.linkedArtistId : undefined;

  if (!artistId) {
    const name =
      resolution.name ??
      params.declaredArtistName ??
      metadata.artistName ??
      identity?.artistName ??
      verifiedIsrc?.artistName;
    if (name) {
      const contributed = await ensureContributedArtist({
        name,
        /**
         * The MBID is what makes the new profile more than a name.
         * `ensureContributedArtist` queues background enrichment only for an
         * artist that has one — enrichment refuses the rest — so a stub created
         * without it stays a bare page nothing ever goes back to fill.
         */
        musicbrainzArtistId: metadata.musicbrainz.artistId ?? identity?.musicbrainzArtistId,
        genres: metadata.genres,
      });
      if (!contributed) {
        return refuse(
          422,
          'artist_name_denylisted',
          `"${name}" is a placeholder rather than an artist, so this file cannot be ` +
            'published to the public catalogue. Set the real artist on the review ' +
            'screen, or keep the file in your private library.',
        );
      }
      artistId = contributed._id.toString();
    }
  }

  /**
   * An artist profile without a photo is the state nothing ever goes back to
   * fix: the page renders as a placeholder, and the person it names has no
   * reason to visit it, so it stays bare indefinitely.
   *
   * Checked AFTER resolution rather than before, because whether a photo is
   * needed depends on the target: a profile that already has one keeps it —
   * their branding is not a contributor's to overwrite — and only a bare one
   * asks the uploader for it. That also repairs profiles an earlier
   * contribution left empty, instead of grandfathering them forever.
   *
   * `ensureContributedArtist` already stored the supplied image when it CREATED
   * the profile; this fills the gap for a profile that already existed. Only an
   * unclaimed one is written to: once somebody has claimed the profile, its
   * photo is theirs.
   */
  if (artistId) {
    const target = await ArtistModel.findById(artistId)
      .select('image claimable claimedByOxyUserId')
      .lean();
    /**
     * Only a bare, UNCLAIMED profile is written to: an artist who already has a
     * photo keeps it, because their branding is not a contributor's to
     * overwrite, and once claimed the photo is theirs.
     */

  }

  const decision = await evaluatePublicContribution({
    uploaderOxyUserId: params.uploaderOxyUserId,
    artistId,
  });

  if (!decision.allowed) {
    // `decision.code` IS the wire code: the policy service and the shared contract
    // share one vocabulary, so a code compliance adds without adding it to
    // `uploadBlockedReasonSchema` fails to compile right here rather than
    // reaching a client as something it cannot switch on.
    return refuse(decision.status, decision.code, decision.message);
  }

  if (decision.requiresAttestation && !params.attestation?.trim()) {
    return refuse(
      422,
      'attestation_required',
      'Publishing a recording under an artist you do not own requires you to confirm ' +
        'that you have the right to distribute it.',
    );
  }

  const artist = await ArtistModel.findById(decision.artistId).select('name').lean();
  if (!artist) {
    return refuse(404, 'artist_not_found', 'That artist profile does not exist.');
  }

  return {
    allowed: true,
    artistId: decision.artistId,
    artistName: artist.name,
    requiresAttestation: decision.requiresAttestation,
  };
}

// ── Publication to the public catalogue ──────────────────────────────────────

interface PublishParams {
  uploaderOxyUserId: string;
  artistId: string;
  artistName: string;
  requiresAttestation: boolean;
  attestation?: string;
  metadata: ExtractedMetadata;
  overrides: StoreLockerParams['overrides'] & { isExplicit?: boolean };
  format: AudioFormat;
  /** Local path to the audio bytes; may be a temp copy staged from the locker. */
  filePath: string;
  /**
   * The acoustic fingerprint, when one could be computed.
   *
   * Published alongside the track so the dedup chain and the copyright purge can
   * find this recording acoustically later — see the note on the write itself.
   */
  fingerprint?: Fingerprint;
  report: ScreeningReport;
  /**
   * The recording the fingerprint resolved to, when it resolved to one. Fills
   * the identifiers the file itself did not carry — never replaces them.
   */
  identity?: AcousticIdentity;
  /**
   * The recording the uploader's VERIFIED ISRC resolved to. Same gap-filling
   * rule, one tier lower: it supplies the release facts (title, date, track
   * count) for a file whose tags carry none, and never overwrites one that does.
   */
  verifiedIsrc?: IsrcRecording;
  ip?: string;
  userAgent?: string;
}

/**
 * The release container a contributed track belongs to, when one can be
 * justified — otherwise nothing, and the track hangs loose under the artist.
 *
 * Three outcomes, and the middle one is the interesting one:
 *
 *  - HIGH confidence (a UPC or a MusicBrainz release id resolved to an existing
 *    album) → link to it. Only `linkedAlbumId` is an identity; the resolver
 *    populates it at high confidence alone.
 *  - MEDIUM confidence (`matchedAlbumId` — the album key matched a title under
 *    this artist, but nothing identifies the RELEASE) → link to nothing and
 *    create nothing. Linking would attach a track to a release on the strength
 *    of a normalised string, and creating would put a near-duplicate container
 *    beside the one we just found. A loose track is recoverable; either of those
 *    is a catalog edit nobody can see to undo.
 *  - Nothing similar exists → create the container.
 *
 * `ensureContributedAlbum` returns null when the release has no cover art or no
 * date, and that refusal is deliberate — `Album.coverArt` and `releaseDate` are
 * required columns, and the only ways to fill them from a file that does not
 * supply them are inventing a placeholder image and inventing a date. Both are
 * irreversible lies in a shared catalog, so the tracks stay loose instead.
 */
async function resolveContributedAlbum(
  params: PublishParams,
): Promise<{ id: string; title: string } | undefined> {
  const { metadata, overrides, identity, verifiedIsrc } = params;

  // The release the file names, or — for a file that names none — the one the
  // verified ISRC resolved to. A recovered title only ever fills an absence.
  /**
   * A placeholder is an ABSENCE, not a declaration — and that distinction
   * decides two things at once.
   *
   * `provenanceSignals` already reads `Unknown Album` as evidence that a ripper
   * had no release to name, while this function was accepting the same string
   * as a title: the two halves of the pipeline disagreed about what it meant.
   * Believing it created a catalog `Album` document literally called "Unknown
   * Album" that every later file carrying the same placeholder then JOINED,
   * gathering unrelated recordings by unrelated artists into one release.
   *
   * Treating it as absent rather than merely rejecting it is what lets the
   * release title a verified ISRC recovered fill the hole — the file that has a
   * placeholder is exactly the file whose real release we had to look up. And
   * where nothing fills it, no album is created and the track hangs under the
   * artist, which is the right shape for a recording whose release is unknown.
   */
  const declared = preferOverride(overrides.albumName, metadata.albumName);
  const albumName =
    declared && !isDenylistedAlbumName(declared) ? declared : verifiedIsrc?.albumName;
  if (!albumName || isDenylistedAlbumName(albumName)) return undefined;

  const resolutionInput = {
    albumName,
    albumArtistName: metadata.albumArtistName ?? params.artistName,
    artistId: params.artistId,
    year: overrides.year ?? metadata.year,
    upc: metadata.upc,
    musicbrainzReleaseId: metadata.musicbrainz.releaseId ?? identity?.releaseMbid,
    /**
     * The release's own track count. Recovering it matters for what it
     * prevents: `classifyAlbumType` reads "under thirty minutes" as EP-shaped,
     * so a release that cannot state how many tracks it has has already been
     * mis-typed once.
     */
    totalTracks: metadata.totalTracks ?? verifiedIsrc?.totalTracks,
    /**
     * Deliberately absent.
     *
     * `totalDurationSec` means the running time of the whole RELEASE, which a
     * single-file upload does not know — it only knows this one track. Passing
     * the track's duration classified a 12-track album as an `ep`, because the
     * classifier reads "under thirty minutes" as EP-shaped. Only a grouped
     * multi-file upload can answer this, and until one exists the honest answer
     * is nothing.
     */
    compilation: metadata.compilation,
  };

  const resolution = await resolveAlbum(resolutionInput);

  if (resolution.confidence === 'high' && resolution.linkedAlbumId) {
    return { id: resolution.linkedAlbumId, title: resolution.title ?? albumName };
  }

  if (resolution.matchedAlbumId) return undefined;

  /**
   * The date is taken from the tag at whatever granularity the tag stated — a
   * file declaring only `2019` yields `2019`, not `2019-01-01`. Widening a year
   * into a day would be inventing a fact the file never carried, which is the
   * same class of mistake as inventing the cover.
   */
  const releaseDate =
    metadata.releaseDate ??
    (resolutionInput.year !== undefined ? String(resolutionInput.year) : undefined) ??
    verifiedIsrc?.releaseDate;

  const created = await ensureContributedAlbum({
    title: albumName,
    artistId: params.artistId,
    artistName: params.artistName,
    coverArt: overrides.coverArt,
    releaseDate,
    type: classifyAlbumType(resolutionInput),
    totalTracks: resolutionInput.totalTracks,
    genres: overrides.genres?.length ? overrides.genres : metadata.genres,
    upc: metadata.upc,
    musicbrainzReleaseId: metadata.musicbrainz.releaseId ?? identity?.releaseMbid,
    /**
     * The release-GROUP id, which is the fallback Cover Art Archive lookup.
     *
     * Not redundant with `musicbrainzReleaseId`: CAA publishes plenty of artwork
     * only at release-group level. Without this the fallback cannot fire, and
     * because `Album.coverArt` is a required column, an album whose only artwork
     * lives there is not merely uncovered — it is never created at all, and the
     * tracks stay loose under the artist.
     */
    musicbrainzReleaseGroupId: metadata.musicbrainz.releaseGroupId ?? identity?.releaseGroupMbid,
    label: metadata.label,
    copyright: metadata.copyright,
    isExplicit: overrides.isExplicit ?? metadata.isExplicit,
  });

  if (!created) {
    logger.info('[uploads] contributed track left loose — no album could be justified', {
      albumName,
      artistId: params.artistId,
      hasCoverArt: Boolean(overrides.coverArt),
      hasReleaseDate: Boolean(releaseDate),
    });
    return undefined;
  }

  return { id: created._id.toString(), title: created.title };
}

/**
 * Create the catalogue `Track`, record the attestation, hand it to ingest.
 *
 * Fields are assigned one by one from validated values; `req.body` is never
 * spread and never reaches a model constructor, so a caller cannot set
 * `artistId`, `source`, `popularity` or any takedown field through this path.
 * `artistId` in particular comes from the contribution matrix's decision, not
 * from the request.
 */
async function publishContribution(params: PublishParams): Promise<string> {
  const { metadata, overrides, format } = params;

  /**
   * The file's ISRC, the one its fingerprint resolved to, or the one the
   * uploader supplied and this pipeline then VERIFIED against the audio — in
   * that order of precedence.
   *
   * Persisting the recovered identifier is the point of recovering it: it is
   * what `matchCatalog` tier 2 dedups on and what `resolveArtist` tier 1 reads,
   * so a track published without it would meet the next upload of the same
   * recording as a fresh unidentifiable file.
   */
  const isrc = metadata.isrc ?? params.identity?.isrc ?? params.verifiedIsrc?.isrc;

  const trackId = new mongoose.Types.ObjectId();
  const coverArtColors = overrides.coverArt
    ? await getStoredImageColors(overrides.coverArt)
    : undefined;

  const album = await resolveContributedAlbum(params);
  const taggedAlbumName = preferOverride(overrides.albumName, metadata.albumName);

  const track = new TrackModel({
    _id: trackId,
    title: preferOverride(overrides.title, metadata.title) ?? 'Untitled',
    artistId: params.artistId,
    artistName: params.artistName,
    albumId: album?.id,
    /**
     * The free-text fallback runs through the same placeholder check as the
     * album document, or refusing to CREATE an "Unknown Album" release would
     * still leave every track captioned with the placeholder — the pollution
     * moved rather than stopped.
     */
    albumName:
      album?.title ??
      (taggedAlbumName && !isDenylistedAlbumName(taggedAlbumName) ? taggedAlbumName : undefined),
    duration: metadata.technical.durationSec,
    trackNumber: overrides.trackNumber ?? metadata.trackNumber,
    discNumber: overrides.discNumber ?? metadata.discNumber,
    audioSource: {
      url: `/api/audio/${trackId.toString()}`,
      format,
      bitrate: metadata.technical.bitrateKbps,
      duration: metadata.technical.durationSec,
    },
    coverArt: overrides.coverArt,
    primaryColor: coverArtColors?.primaryColor,
    secondaryColor: coverArtColors?.secondaryColor,
    metadata: {
      genre: overrides.genres?.length ? overrides.genres : metadata.genres,
      bpm: metadata.bpm,
      key: metadata.key,
      explicit: overrides.isExplicit ?? metadata.isExplicit ?? false,
      language: metadata.language,
      copyright: metadata.copyright,
      publisher: metadata.publisher,
    },
    isExplicit: overrides.isExplicit ?? metadata.isExplicit ?? false,
    isAvailable: true,
    playCount: 0,
    popularity: 0,
    source: 'upload',
    status: 'processing',
    externalIds: isrc ? { isrc: isrc.toUpperCase() } : undefined,
    /**
     * The content hash travels with the track, and without this line the whole
     * first tier of dedup is dead.
     *
     * `matchCatalog` tier 1 answers "these exact bytes are already in the
     * catalogue" by reading `Track.sha256` — the cheapest and most certain tier
     * there is. Nothing else in the codebase writes that field, so until this
     * upload path filled it, every re-upload of a track Syra already hosts fell
     * through to fingerprinting and fuzzy matching, and a file with stripped tags
     * matched nothing at all.
     */
    sha256: metadata.sha256,
  });

  /**
   * The album id MUST match what the track is saved with.
   *
   * `getS3AudioKey` puts the object under `audio/{artist}/{album}/{track}` when
   * an album is known and `audio/{artist}/{track}` when it is not — so the id
   * passed here does not merely tag the object, it decides the key. Ingest
   * re-derives that key from the PERSISTED track, so passing `undefined` while
   * saving `album?.id` wrote the audio to one path and read it from another:
   * every contribution that resolved an album ingested to `NoSuchKey`, left no
   * HLS behind, and surfaced to the listener as a track that lists fine and
   * plays "no supported source was found". Contributions with no album resolved
   * kept working, which is what made it look like metadata rather than storage.
   */
  await uploadTrackAudio(
    {
      id: trackId.toString(),
      artistId: params.artistId,
      albumId: album?.id,
      title: track.title,
      audioSource: track.audioSource,
    },
    fs.createReadStream(params.filePath),
  );

  const saved = await track.save();

  if (params.requiresAttestation && params.attestation) {
    // The screening result that was current at signing time is part of the
    // record: an attestation with no evidence of what it was signed against
    // proves nothing, and proving something is the only reason it exists.
    await ContributionAttestationModel.create({
      trackId: saved._id.toString(),
      uploaderOxyUserId: params.uploaderOxyUserId,
      statement: params.attestation,
      acceptedAt: new Date(),
      ip: params.ip,
      userAgent: params.userAgent,
      provenanceReport: params.report,
      /**
       * What the file itself declared, kept beside the signature.
       *
       * An attestation says "I may distribute this"; the raw tags say what the
       * uploader was looking at when they said it. A claim months later is
       * answered from the pair — the statement alone proves only that a box was
       * ticked, and the source object may be long deleted by then.
       */
      rawTags: params.metadata.rawTags,
    });
  }

  /**
   * Index the recording acoustically.
   *
   * `TrackFingerprint` is READ by `matchCatalog` tier 3 and by the third leg of
   * compliance's takedown purge, and before this write nothing in the codebase
   * created a row — so both were querying a permanently empty collection. That is
   * the difference between a purge that catches a re-encode of a taken-down
   * recording and one that only catches byte-identical copies.
   *
   * Best-effort: a missing acoustic index degrades matching, while failing the
   * publication would lose a track the uploader was told was accepted.
   */
  if (params.fingerprint) {
    await indexTrackAcoustically(saved._id.toString(), params.fingerprint).catch((err: unknown) =>
      logger.error('[uploads] failed to index the published track acoustically', {
        trackId: saved._id.toString(),
        message: getErrorMessage(err),
      }),
    );
  }

  await ArtistModel.updateOne({ _id: params.artistId }, { $inc: { 'stats.tracks': 1 } });

  /**
   * `totalDuration` accumulates; `totalTracks` does NOT.
   *
   * They are different kinds of fact. `totalDuration` is how much audio of this
   * release Syra actually hosts, so every track added to it adds to that.
   * `totalTracks` is the release's own track count, taken from the right-hand
   * side of `TRCK` (`3/12`) — a property of the record, not of how much of it we
   * happen to have. Incrementing it made a 12-track album report 13 after one
   * upload, and would have kept climbing with every contribution.
   */
  if (album) {
    await AlbumModel.updateOne(
      { _id: album.id },
      { $inc: { totalDuration: metadata.technical.durationSec } },
    );
  }

  await enqueueIngest(saved._id.toString());

  return saved._id.toString();
}

// ── POST /api/uploads ────────────────────────────────────────────────────────

/**
 * The one path a listener's file enters Syra by.
 *
 * Wrapped in multer's callback rather than used as middleware so the temp file
 * has exactly one owner: every exit below — rejection, throw, success — passes
 * through the same `finally`.
 */
export const createUpload = (req: AuthRequest, res: Response, _next: NextFunction): void => {
  lockerUpload(req, res, async (err: unknown) => {
    if (err) {
      logger.warn('[uploads] multipart parse failed', { message: getErrorMessage(err) });
      res.status(400).json({ error: 'Upload error', message: getErrorMessage(err) });
      return;
    }

    const file = (req as AudioUploadRequest).file;
    const tempPath = file?.path;

    try {
      if (!isDatabaseConnected()) {
        res.status(503).json({ error: 'Database not available' });
        return;
      }

      const userId = getRequiredOxyUserId(req);

      if (!file) {
        res.status(400).json({ error: 'Missing file', message: 'An audio file is required' });
        return;
      }

      const rawBody: Record<string, unknown> = req.body ?? {};
      const parsed = uploadTrackRequestSchema.safeParse(normalizeMultipartFields(rawBody));
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
        return;
      }
      const request = parsed.data;

      if (request.coverArt && !mongoose.Types.ObjectId.isValid(request.coverArt)) {
        res.status(400).json({
          error: 'Invalid coverArt',
          message:
            'coverArt must be an image id (MongoDB ObjectId). Upload the image first via /api/images/upload.',
        });
        return;
      }

      const format = AUDIO_MIME_TO_FORMAT[file.mimetype];
      if (!format) {
        res.status(400).json({ error: 'Unsupported audio format' });
        return;
      }

      // 1. Read the file. ffprobe is the authority for duration and bitrate, so a
      //    file it cannot demux is refused here rather than stored and left
      //    describing itself with numbers nothing measured.
      let metadata: ExtractedMetadata;
      try {
        metadata = await extractMetadata(file.path);
      } catch (extractError: unknown) {
        logger.warn('[uploads] could not read uploaded audio', {
          message: getErrorMessage(extractError),
        });
        res.status(400).json({
          error: 'Unreadable audio',
          message: 'The audio file could not be read. Please upload a valid audio file.',
        });
        return;
      }

      // 2. Acoustic fingerprint. A missing `fpcalc` is a degraded environment, not
      //    a bad file: screening continues without the acoustic signal. A fpcalc
      //    that RAN and rejected the file is a file problem and is refused.
      // A missing fingerprint NEVER rejects the upload, whatever the cause.
      // `ffprobe` has already established that this is decodable audio and given
      // us its real duration and codec, so `fpcalc` failing is not evidence the
      // file is bad — it means Chromaprint could not derive a fingerprint from
      // it. `ERROR: Empty fingerprint` on a very short or near-silent clip is the
      // common case. Rejecting here also made the outcome depend on WHY the
      // signal is absent: a missing binary (`unavailable`) let the upload
      // through while an unfingerprintable file did not, which is incoherent —
      // both end in the same place, an upload screened without an acoustic
      // signal. The consequences are bounded and already handled downstream:
      // dedup tier 3 and the foreign-artist marker simply do not contribute.
      const fingerprintResult = await fingerprintFile(file.path);
      if (fingerprintResult.status !== 'ok') {
        logger.warn('[uploads] acoustic screening skipped', {
          status: fingerprintResult.status,
          reason: fingerprintResult.reason,
        });
      }
      const fingerprint: Fingerprint | undefined =
        fingerprintResult.status === 'ok'
          ? { values: fingerprintResult.values, durationSec: fingerprintResult.durationSec }
          : undefined;

      // 3. Dedup, before a single byte is stored.
      const match = await matchCatalog(
        {
          sha256: metadata.sha256,
          durationSec: metadata.technical.durationSec,
          title: preferOverride(request.title, metadata.title),
          artistName: preferOverride(request.artistName, metadata.artistName),
          isrc: metadata.isrc,
          fingerprint: fingerprint?.values,
        },
        userId,
      );

      if (match.kind === 'track') {
        // The best possible outcome: the recording is already in the catalogue, so
        // nothing is transferred and nothing new is distributed. The client adds
        // the existing track to the library.
        const outcome: UploadOutcome = { outcome: 'matched', trackId: match.trackId };
        res.status(200).json(outcome);
        return;
      }

      if (match.kind === 'upload') {
        const outcome: UploadOutcome = { outcome: 'duplicate', uploadId: match.uploadId };
        res.status(200).json(outcome);
        return;
      }

      /**
       * 4. Screen — with the acoustic evidence the matcher already found.
       *
       * `nearestFingerprint` is a catalogue recording this audio matches but that
       * did NOT become a dedup hit, because the copy is removed or unavailable.
       * That is the case the HIGH-weight `fingerprint.other-artist` marker exists
       * for, and it is where the signal matters most: a match against a recording
       * Syra has already judged infringing. Passing nothing here left the whole
       * marker unreachable in production.
       */
      const acousticNeighbour = match.nearestFingerprint;

      /**
       * What the AUDIO says this recording is, before anything is decided.
       *
       * Placed here, ahead of screening and therefore ahead of every gate below,
       * because it changes both answers a gate can give. A file carrying no ISRC
       * gets one resolved instead of being refused for not having one; a file
       * that resolves to a commercially released recording is refused however
       * clean its tags look. The same lookup does both — which is the reason it
       * is safe to run at all, since it identifies rips as readily as it rescues
       * legitimate uploads.
       */
      const identity =
        request.destination === 'public' ? await identifyForPublication(fingerprint) : undefined;

      const { report } = await collectProvenanceSignals(metadata, {
        ...(acousticNeighbour && {
          foreignFingerprintMatch: {
            trackId: acousticNeighbour.trackId,
            artistName: acousticNeighbour.artistName,
            bitErrorRate: acousticNeighbour.bitErrorRate,
          },
        }),
        ...acousticEvidence(identity),
      });

      /**
       * The file's own embedded front cover, when the uploader did not name an
       * image of their own.
       *
       * Stored for the locker whatever its size — it is the owner's file and
       * their artwork — but only PROMOTED to catalogue cover art above the
       * minimum, which is what `catalogEligible` records. Uploading it here also
       * makes album creation possible at all: `ensureContributedAlbum` refuses to
       * invent a placeholder, so a release with no artwork gets no container.
       */
      const embeddedCover = request.coverArt
        ? undefined
        : await storeEmbeddedCoverArt(metadata, userId);

      const overrides = {
        title: request.title,
        artistName: request.artistName,
        albumName: request.albumName,
        trackNumber: request.trackNumber,
        discNumber: request.discNumber,
        year: request.year,
        genres: request.genres,
        coverArt: request.coverArt ?? embeddedCover?.imageId,
      };

      // 5a. Private destination — an unresolved artist is fine here, by design.
      if (request.destination === 'private') {
        // Read-only resolution: it groups and labels the file in the owner's
        // library. `ensureContributedArtist` is deliberately NOT called on this
        // path — a private upload must never seed the public catalog with an
        // artist row, which is exactly what creating a stub for every locker file
        // would do.
        const resolution = await resolveArtist({
          isrc: metadata.isrc,
          musicbrainzArtistId: metadata.musicbrainz.artistId,
          artistName: preferOverride(request.artistName, metadata.artistName),
          albumArtistName: metadata.albumArtistName,
          fingerprintMatch: acousticNeighbour && {
            artistId: acousticNeighbour.artistId,
            artistName: acousticNeighbour.artistName,
          },
          fileName: file.originalname,
          relativePath: file.originalname.includes('/') ? file.originalname : undefined,
        });

        const result = await storeLockerUpload({
          ownerOxyUserId: userId,
          metadata,
          overrides,
          format,
          filePath: file.path,
          originalName: file.originalname,
          fingerprint,
          report,
          resolvedArtistId:
            resolution.confidence === 'high' ? resolution.linkedArtistId : undefined,
        });

        if ('duplicateUploadId' in result) {
          const outcome: UploadOutcome = {
            outcome: 'duplicate',
            uploadId: result.duplicateUploadId,
          };
          res.status(200).json(outcome);
          return;
        }

        const outcome: UploadOutcome = {
          outcome: 'stored',
          upload: toUploadTrackDto(result.stored),
        };
        res.status(201).json(outcome);
        return;
      }

      /**
       * 5b. Public destination.
       *
       * Cover art is checked FIRST, before the contribution matrix, and the
       * order is load-bearing: `screenPublicContribution` creates a claimable
       * artist stub for an unknown name, so refusing after it would leave an
       * orphan artist row behind for a track that never published — a slow leak
       * of junk into the catalogue that nothing would ever clean up.
       *
       * "Has a cover" is not enough; it has to be one the catalogue can show.
       * An embedded thumbnail below `MIN_CATALOG_COVER_ART_PX` is stored and
       * displayed in the owner's own library, but promoting it to a catalogue
       * page is exactly what that minimum exists to prevent. A user-supplied
       * image comes through the picker and is accepted as-is.
       */
      /**
       * The catalogue takes a RECORDING, and an ISRC is what says which one.
       * Without it the artist can only be matched on a name, which fails both
       * ways: `C. Giró` and `Carlota Giró` become two profiles for one person,
       * while two different artists sharing a name are forced into one by the
       * unique name key. With it, the recording resolves in MusicBrainz to a
       * specific artist with an ISNI, and the photo and credits follow.
       *
       * Checked before the artwork rule and before the contribution matrix, so
       * a file that can never be attributed is refused before any work is done
       * and before any artist stub exists.
       *
       * Creators publishing their OWN music are unaffected: they upload through
       * the studio, where they already own the artist profile.
       */
      /**
       * The file's own ISRC, or the one the fingerprint resolved to.
       *
       * The gap-filling direction the whole pipeline uses: what the file
       * declares always wins, and a recovered value only ever fills an absence.
       * A file that declares an ISRC and resolves to a different recording is
       * NOT reconciled here — that disagreement is evidence, and the markers
       * carry it.
       */
      const identifiedIsrc = metadata.isrc?.trim() || identity?.isrc;

      /**
       * Tier 3, and it runs ONLY where the two tiers above found nothing and
       * the file is not already refused as a commercial release.
       *
       * The `commercial` guard is the same precedence the gates below follow:
       * telling somebody their ISRC does not match, when the real finding is
       * that the file names its purchaser, sends them to fix the wrong thing —
       * and it would spend a network request on an upload that is about to be
       * refused anyway.
       */
      const claim =
        report.verdict === 'commercial'
          ? { accepted: true as const, recording: undefined }
          : await verifyClaimedIsrc({
              claimed: request.isrc,
              identified: identifiedIsrc,
              metadata,
              report,
            });

      if (!claim.accepted) {
        res.status(claim.status).json(claim.outcome);
        return;
      }

      /**
       * Tier 4: search for the recording by what the file already says.
       *
       * Runs last and only on total absence, so it never overrides a code the
       * file declares, one AcoustID resolved, or one the uploader typed. Its
       * whole population is the file that tiers 1–3 miss together — a real
       * release, tagged with title and artist, with no `TSRC`, never
       * fingerprinted, uploaded by somebody who has no way to know a twelve-
       * character code. That file was being refused for carrying no identifier
       * when its identifier was a search away.
       *
       * `discovered` is held separately from `identifiedIsrc` rather than
       * folded into it, because a code Syra went and found is not a code the
       * file declared: the enrichment below reads the recording it resolved to,
       * and the distinction is what keeps a discovered value from being treated
       * as the file's own declaration.
       */
      const discovered =
        report.verdict !== 'commercial' && !identifiedIsrc && !claim.recording
          ? await discoverIsrc({
              durationSec: metadata.technical.durationSec,
              title: metadata.title,
              artistName: metadata.artistName,
              albumArtistName: metadata.albumArtistName,
            })
          : undefined;

      if (discovered?.status === 'unavailable') {
        // Not a negative result: nothing could be asked. Logged rather than
        // surfaced, because the gate below still decides the outcome and the
        // uploader can supply the code themselves either way.
        logger.warn('[uploads] ISRC discovery unavailable', { reason: discovered.reason });
      }

      const discoveredRecording = discovered?.status === 'found' ? discovered.recording : undefined;
      const resolvedIsrc = identifiedIsrc || claim.recording?.isrc || discoveredRecording?.isrc;

      if (report.verdict !== 'commercial' && !resolvedIsrc) {
        res.status(422).json({
          outcome: 'blocked',
          code: 'isrc_required',
          message:
            'This file carries no ISRC, the international code that identifies a ' +
            'recording. The public catalogue needs one to attribute the track to the ' +
            'right artist. Keep the file in your private library instead.',
          markers: report.markers,
        });
        return;
      }

      const hasCatalogCover = request.coverArt
        ? true
        : embeddedCover?.catalogEligible === true;
      /**
       * Two refusals outrank this one and must keep their own codes, because
       * telling someone to attach artwork when the real problem is "this is a
       * purchased commercial recording" or "this file says who nobody" sends
       * them to fix the wrong thing:
       *
       * - a `commercial` verdict is the more serious finding, and
       * - no artist at all is more fundamental — there is nobody to attribute
       *   the work to.
       *
       * Neither case reaches stub creation either: `ensureContributedArtist`
       * needs a name, so a nameless file leaks nothing by being refused later.
       * The leak this ordering exists to prevent is the narrow one — a
       * resolvable artist plus no cover, where the stub would be created and
       * then stranded.
       */
      const wouldResolveArtist = Boolean(
        request.artistName?.trim() || metadata.artistName?.trim(),
      );
      if (report.verdict !== 'commercial' && wouldResolveArtist && !hasCatalogCover) {
        res.status(422).json({
          outcome: 'blocked',
          code: 'cover_art_required',
          message: embeddedCover
            ? 'This file’s artwork is too small to publish. Attach a larger image, or keep the file in your private library instead.'
            : 'This file has no artwork, and the catalogue needs one. Attach an image, or keep the file in your private library instead.',
          markers: report.markers,
        });
        return;
      }

      const gate = await screenPublicContribution({
        uploaderOxyUserId: userId,
        metadata,
        declaredArtistName: request.artistName,
        fileName: file.originalname,
        // A directory-picker upload sends the path inside the chosen folder as
        // the field name, which is tier 7's `Artist/Album/01 Title.mp3`.
        relativePath: file.originalname.includes('/') ? file.originalname : undefined,
        acoustic: acousticNeighbour && {
          artistId: acousticNeighbour.artistId,
          artistName: acousticNeighbour.artistName,
        },
        attestation: request.attestation,
        report,
        identity,
        verifiedIsrc: claim.recording ?? discoveredRecording,
      });

      if (!gate.allowed) {
        res.status(gate.status).json(gate.outcome);
        return;
      }

      const trackId = await publishContribution({
        uploaderOxyUserId: userId,
        artistId: gate.artistId,
        artistName: gate.artistName,
        requiresAttestation: gate.requiresAttestation,
        attestation: request.attestation,
        metadata,
        overrides: {
          ...overrides,
          // A thumbnail is fine in somebody's own library and wrong on an album
          // page every listener sees, so the catalogue only takes artwork that
          // cleared the size floor.
          coverArt:
            request.coverArt ?? (embeddedCover?.catalogEligible ? embeddedCover.imageId : undefined),
          isExplicit: request.isExplicit,
        },
        format,
        filePath: file.path,
        fingerprint,
        report,
        identity,
        verifiedIsrc: claim.recording ?? discoveredRecording,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      const outcome: UploadOutcome = { outcome: 'published', trackId };
      res.status(201).json(outcome);
    } catch (error: unknown) {
      logger.error('[uploads] upload failed', {
        message: getErrorMessage(error),
        stack: getErrorStack(error),
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Upload failed',
          ...(env.NODE_ENV === 'development' && { details: getErrorMessage(error) }),
        });
      }
    } finally {
      if (tempPath) {
        await fs.promises.rm(tempPath, { force: true }).catch((rmError: unknown) =>
          logger.warn('[uploads] failed to remove upload temp file', {
            tempPath,
            message: getErrorMessage(rmError),
          }),
        );
      }
    }
  });
};

// ── GET /api/uploads ─────────────────────────────────────────────────────────

/** The caller's own locker, newest first. Never anybody else's — there is no id parameter. */
export const listUploads = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isDatabaseConnected()) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = getRequiredOxyUserId(req);
    const limit = parseBoundedLimit(req.query.limit, 50);
    const offset = parseOffset(req.query.offset);
    const filter = { ownerOxyUserId: userId, deletedAt: null };

    const [uploads, total] = await Promise.all([
      UserUploadModel.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).exec(),
      UserUploadModel.countDocuments(filter),
    ]);

    res.json({
      uploads: uploads.map(toUploadTrackDto),
      total,
      hasMore: offset + uploads.length < total,
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/uploads/albums ──────────────────────────────────────────────────

/**
 * The caller's locker, grouped into albums.
 *
 * There is no per-user `Album` collection and there must not be one — a private
 * file may not create a catalog container, and that constraint is the reason the
 * locker stores a computed `albumKey` instead. Album pages are an aggregation
 * over that key, which gives the full release structure with zero catalog
 * contamination.
 *
 * Runs against `{ownerOxyUserId, albumKey, discNumber, trackNumber}`, the exact
 * index foundation built for it: the owner match and the grouping key are its
 * leading fields, and the sort inside each release is the rest of it, so the
 * whole thing is served from the index without an in-memory sort.
 *
 * Owner scope comes from the session and appears in the FIRST stage. Never from
 * a parameter — there is no route by which a caller can name someone else.
 */
export const listUploadAlbums = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!isDatabaseConnected()) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = getRequiredOxyUserId(req);

    const grouped = await UserUploadModel.aggregate<{
      _id: string;
      albumName?: string;
      albumArtistName?: string;
      year?: number;
      coverArt?: string;
      trackCount: number;
      totalDuration: number;
      trackIds: mongoose.Types.ObjectId[];
    }>([
      {
        $match: {
          ownerOxyUserId: userId,
          deletedAt: null,
          // A file with no album tags has no release to belong to. Grouping the
          // untagged ones together would invent an album called nothing.
          albumKey: { $nin: [null, ''] },
        },
      },
      { $sort: { albumKey: 1, discNumber: 1, trackNumber: 1 } },
      {
        $group: {
          _id: '$albumKey',
          // `$first` after the sort, so a release is titled by its lowest-numbered
          // track rather than by whichever document the storage engine returned.
          albumName: { $first: '$albumName' },
          albumArtistName: { $first: '$albumArtistName' },
          year: { $first: '$year' },
          coverArt: { $first: '$coverArt' },
          trackCount: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          trackIds: { $push: '$_id' },
        },
      },
      { $sort: { albumArtistName: 1, year: 1, albumName: 1 } },
    ]);

    res.json({
      albums: grouped.map((album) => ({
        albumKey: album._id,
        albumName: album.albumName,
        albumArtistName: album.albumArtistName,
        year: album.year,
        coverArt: normalizeImageRef(album.coverArt),
        trackCount: album.trackCount,
        totalDuration: album.totalDuration,
        trackIds: album.trackIds.map((id) => id.toString()),
      })),
      total: grouped.length,
    });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/uploads/:id ─────────────────────────────────────────────────────

export const getUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = getRequiredOxyUserId(req);
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, userId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    res.json(toUploadTrackDto(upload));
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/uploads/:id ───────────────────────────────────────────────────

/**
 * Correct the metadata that was read out of the file.
 *
 * Explicit field-by-field assignment from the parsed body; the request is never
 * spread onto the document, so `ownerOxyUserId`, `sha256`, `audioSource`,
 * `matchedTrackId`, `expiresAt` and the retention stamps are all unreachable from
 * here. `duration` is likewise absent from the editable set — it is measured, and
 * a listener typing over it would break the fuzzy-dedup window and the scrubber.
 */
export const updateUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = getRequiredOxyUserId(req);
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const parsed = updateUserUploadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }

    const upload = await findOwnedUpload(uploadId, userId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const updates = parsed.data;

    if (updates.coverArt !== undefined && !mongoose.Types.ObjectId.isValid(updates.coverArt)) {
      res.status(400).json({
        error: 'Invalid coverArt',
        message: 'coverArt must be an image id (MongoDB ObjectId).',
      });
      return;
    }

    if (updates.title !== undefined) upload.title = updates.title;
    if (updates.artistName !== undefined) upload.artistName = updates.artistName;
    if (updates.albumName !== undefined) upload.albumName = updates.albumName;
    if (updates.trackNumber !== undefined) upload.trackNumber = updates.trackNumber;
    if (updates.discNumber !== undefined) upload.discNumber = updates.discNumber;
    if (updates.year !== undefined) upload.year = updates.year;
    if (updates.genres !== undefined) upload.genres = updates.genres;
    if (updates.coverArt !== undefined) {
      upload.coverArt = updates.coverArt;
      const colors = await getStoredImageColors(updates.coverArt);
      upload.primaryColor = colors?.primaryColor;
      upload.secondaryColor = colors?.secondaryColor;
    }

    await upload.save();

    res.json(toUploadTrackDto(upload));
  } catch (error) {
    next(error);
  }
};

// ── DELETE /api/uploads/:id ──────────────────────────────────────────────────

/**
 * Delete a locker file for good — bytes first, then the document.
 *
 * That order, never the reverse: a failure after the objects are gone leaves a
 * row pointing at nothing, which is recoverable. A failure after the row is gone
 * leaves audio in the bucket that nothing will ever name again.
 *
 * The object list comes from the compliance purge helper rather than a second
 * implementation here, because it carries the guard that refuses to sweep an HLS
 * prefix which does not contain this upload's own id.
 */
export const deleteUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const userId = getRequiredOxyUserId(req);
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const upload = await UserUploadModel.findOne({ _id: uploadId, ownerOxyUserId: userId }).exec();
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    await deleteUploadStoredObjects(upload);
    await UserUploadModel.deleteOne({ _id: upload._id });
    await TrackKeyModel.deleteOne({ trackId: upload._id.toString() });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
};

// ── POST /api/uploads/:id/promote ────────────────────────────────────────────

/**
 * Contribute a file already in the locker to the public catalogue.
 *
 * The locker copy is KEPT and pointed at the new track through `matchedTrackId`.
 * That is not sentiment about the uploader's file: it is what makes the
 * compliance purge reach these bytes. `purgeLockerCopiesOfTrack` finds locker
 * copies by `matchedTrackId` first, so if the track it created is ever taken
 * down, the file that created it goes with it instead of quietly surviving the
 * takedown of its own publication.
 *
 * The bytes are staged through a temp file rather than copied in the bucket:
 * catalogue ingest reads the audio at the TRACK's key, and the two key spaces are
 * deliberately separate so a locker object is never addressable as catalogue.
 */
export const promoteUpload = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  let stagedDir: string | undefined;

  try {
    if (!isDatabaseConnected()) {
      res.status(503).json({ error: 'Database not available' });
      return;
    }

    const userId = getRequiredOxyUserId(req);
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, userId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    if (upload.matchedTrackId) {
      res.status(409).json({
        error: 'Already published',
        message: 'This file has already been contributed to the catalogue.',
      });
      return;
    }

    if (upload.status !== 'ready' || !upload.audioSource?.key) {
      res.status(409).json({
        error: 'Upload not ready',
        message: 'This file is still being processed.',
      });
      return;
    }

    const rawBody: Record<string, unknown> = req.body ?? {};
    const parsed = uploadTrackRequestSchema.safeParse({
      ...normalizeMultipartFields(rawBody),
      destination: 'public',
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
      return;
    }
    const request = parsed.data;

    // Stage the stored bytes locally: every screening tool wants a path, and the
    // catalogue's ingest reads from the track's own key, not the locker's.
    stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-'));
    const stagedPath = path.join(stagedDir, `source.${upload.audioSource.format}`);
    const { stream } = await streamFromS3(upload.audioSource.key);
    await new Promise<void>((resolve, reject) => {
      const destination = fs.createWriteStream(stagedPath);
      stream.pipe(destination);
      destination.on('finish', resolve);
      destination.on('error', reject);
      stream.on('error', reject);
    });

    const metadata = await extractMetadata(stagedPath);

    /**
     * Run the dedup chain again before publishing.
     *
     * The catalogue has moved on since this file was stored: the recording may
     * have been uploaded by its actual artist in the meantime, and contributing
     * it now would create a second copy of a track that is already there. A
     * catalogue hit answers `matched` and links the locker file to the track it
     * turned out to be — which is also what puts these bytes inside the reach of
     * a future takedown of that track.
     */
    const match = await matchCatalog(
      {
        sha256: upload.sha256,
        durationSec: metadata.technical.durationSec,
        title: request.title ?? upload.title,
        artistName: request.artistName ?? upload.artistName,
        isrc: metadata.isrc,
        fingerprint: upload.fingerprint,
      },
      userId,
    );

    if (match.kind === 'track') {
      upload.matchedTrackId = match.trackId;
      await upload.save();
      const outcome: UploadOutcome = { outcome: 'matched', trackId: match.trackId };
      res.status(200).json(outcome);
      return;
    }

    // Only the `none` arm carries acoustic evidence: a locker hit here is this
    // file finding ITSELF, which says nothing about the catalogue.
    const promoteAcoustic = match.kind === 'none' ? match.nearestFingerprint : undefined;

    /**
     * The same acoustic identification the direct upload performs, and it has to
     * happen here too rather than being inherited from the locker record: the
     * lookup is deliberately skipped for a private file, so promotion is the
     * FIRST time this recording is asked about. Without it, filing a rip in the
     * locker and promoting it a minute later would be the way around the block.
     *
     * The stored fingerprint is reused, so promotion costs no extra decode.
     */
    const promoteFingerprint: Fingerprint | undefined =
      upload.fingerprint?.length && upload.fingerprintDurationSec !== undefined
        ? { values: upload.fingerprint, durationSec: upload.fingerprintDurationSec }
        : undefined;
    const identity = await identifyForPublication(promoteFingerprint);

    const { report } = await collectProvenanceSignals(metadata, {
      ...(promoteAcoustic && {
        foreignFingerprintMatch: {
          trackId: promoteAcoustic.trackId,
          artistName: promoteAcoustic.artistName,
          bitErrorRate: promoteAcoustic.bitErrorRate,
        },
      }),
      ...acousticEvidence(identity),
    });

    /**
     * The same tier-3 check the direct upload performs, for the same reason it
     * performs the acoustic lookup here rather than inheriting one: promotion is
     * a PUBLICATION, and every rule the public path enforces has to hold on it
     * or filing a file privately first becomes the way around them. Omitting it
     * would leave a supplied ISRC silently ignored on this path — the quiet
     * failure this feature exists to prevent.
     */
    const claim =
      report.verdict === 'commercial'
        ? { accepted: true as const, recording: undefined }
        : await verifyClaimedIsrc({
            claimed: request.isrc,
            identified: metadata.isrc?.trim() || identity?.isrc,
            metadata,
            report,
          });

    if (!claim.accepted) {
      res.status(claim.status).json(claim.outcome);
      return;
    }

    const gate = await screenPublicContribution({
      uploaderOxyUserId: userId,
      metadata,
      declaredArtistName: request.artistName ?? upload.artistName,
      acoustic: promoteAcoustic && {
        artistId: promoteAcoustic.artistId,
        artistName: promoteAcoustic.artistName,
      },
      attestation: request.attestation,
      report,
      identity,
      verifiedIsrc: claim.recording,
    });

    if (!gate.allowed) {
      res.status(gate.status).json(gate.outcome);
      return;
    }

    const catalogCoverEligible = await isCatalogEligibleImage(upload.coverArt);

    const trackId = await publishContribution({
      uploaderOxyUserId: userId,
      artistId: gate.artistId,
      artistName: gate.artistName,
      requiresAttestation: gate.requiresAttestation,
      attestation: request.attestation,
      metadata,
      overrides: {
        title: request.title ?? upload.title,
        artistName: request.artistName ?? upload.artistName,
        albumName: request.albumName ?? upload.albumName,
        trackNumber: request.trackNumber ?? upload.trackNumber,
        discNumber: request.discNumber ?? upload.discNumber,
        year: request.year ?? upload.year,
        genres: request.genres ?? upload.genres,
        // The locker's own artwork was stored whatever its size; the catalogue
        // takes it only if it cleared the floor. Read from the stored asset's
        // recorded dimensions rather than re-measuring — and re-uploading — the
        // same image.
        coverArt: request.coverArt ?? (catalogCoverEligible ? upload.coverArt : undefined),
        isExplicit: request.isExplicit,
      },
      format: upload.audioSource.format,
      filePath: stagedPath,
      fingerprint: promoteFingerprint,
      report,
      identity,
      verifiedIsrc: claim.recording,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    upload.matchedTrackId = trackId;
    upload.resolvedArtistId = gate.artistId;
    await upload.save();

    const outcome: UploadOutcome = { outcome: 'published', trackId };
    res.status(201).json(outcome);
  } catch (error) {
    next(error);
  } finally {
    if (stagedDir) {
      fs.rmSync(stagedDir, { recursive: true, force: true });
    }
  }
};

// ── GET /api/uploads/:id/stream ──────────────────────────────────────────────

/**
 * Issue a playback session for a locker file.
 *
 * Mirrors `stream.controller`'s resolver, with two differences that matter:
 * ownership is part of the query that loads the document (so a different session
 * gets 404, not 403 — a stranger must not learn that an id exists), and the
 * bitrate cap is the locker ladder rather than the subscription entitlement.
 *
 * This is also where a play is recorded, which is what pushes `expiresAt` a year
 * forward. Minting a session IS the play: it is the one point every client, on
 * every platform, has to pass through to hear the file.
 */
export const getUploadStream = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(400).json({ error: 'Invalid upload id' });
      return;
    }

    // The resolver MINTS tokens, so it requires a real session — a stream token
    // cannot be used to mint another one.
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, userId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    if (upload.status === 'processing') {
      res.status(409).json({ error: 'Upload processing' });
      return;
    }

    if (upload.status !== 'ready' || !upload.hlsMasterKey || !upload.hls?.length) {
      res.status(422).json({ error: 'Upload not playable' });
      return;
    }

    const token = mintStreamToken(
      { trackId: uploadId, userId, maxBitrateKbps: LOCKER_MAX_BITRATE_KBPS },
      LOCKER_STREAM_SESSION_TTL_SEC,
    );
    const url = `${env.STREAM_KEY_BASE_URL}/api/uploads/${uploadId}/stream/master.m3u8?t=${token}`;
    const expiresAt = new Date(Date.now() + LOCKER_STREAM_SESSION_TTL_SEC * 1000).toISOString();

    await recordUploadPlay(uploadId, userId);

    res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
    res.set('Vary', 'Authorization');
    res.status(200).json({ url, type: 'hls', expiresAt });
  } catch (error) {
    next(error);
  }
};

/** GET /api/uploads/:id/stream/key — the raw AES-128 key, never cached. */
export const getUploadStreamKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(400).json({ error: 'Invalid upload id' });
      return;
    }

    const access = resolveUploadAccess(req, uploadId);
    if (!access.ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, access.ownerOxyUserId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    const trackKey = await TrackKeyModel.findOne({ trackId: uploadId }).lean();
    if (!trackKey) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }

    res.set('Content-Type', CONTENT_TYPE_OCTET_STREAM);
    res.set('Cache-Control', CACHE_CONTROL_NO_STORE);
    res.status(200).send(Buffer.from(trackKey.keyHex, 'hex'));
  } catch (error) {
    next(error);
  }
};

/** GET /api/uploads/:id/stream/master.m3u8 */
export const getUploadMasterPlaylist = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(400).json({ error: 'Invalid upload id' });
      return;
    }

    const access = resolveUploadAccess(req, uploadId);
    if (!access.ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, access.ownerOxyUserId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    if (upload.status === 'processing') {
      res.status(409).json({ error: 'Upload processing' });
      return;
    }

    if (!upload.hlsMasterKey || !upload.hls?.length) {
      res.status(404).json({ error: 'Master playlist not available' });
      return;
    }

    const token = resolveManifestToken(req, uploadId, access.ownerOxyUserId, access.maxBitrateKbps);
    const playlist = await buildMasterPlaylistFor(
      { id: uploadId, hls: upload.hls },
      {
        token,
        baseUrl: env.STREAM_KEY_BASE_URL,
        maxBitrateKbps: access.maxBitrateKbps,
        basePath: `/api/uploads/${uploadId}/stream`,
      },
    );

    res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
    res.set('Cache-Control', CACHE_CONTROL_PRIVATE_SHORT);
    res.set('Vary', 'Authorization');
    res.status(200).send(playlist);
  } catch (error) {
    next(error);
  }
};

/** GET /api/uploads/:id/stream/v/:variant — e.g. `160.m3u8`. */
export const getUploadVariantPlaylist = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const uploadId = getParam(req, 'id');
    if (!mongoose.Types.ObjectId.isValid(uploadId)) {
      res.status(400).json({ error: 'Invalid upload id' });
      return;
    }

    const access = resolveUploadAccess(req, uploadId);
    if (!access.ok) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const upload = await findOwnedUpload(uploadId, access.ownerOxyUserId);
    if (!upload) {
      res.status(404).json({ error: 'Upload not found' });
      return;
    }

    if (!upload.hls?.length) {
      res.status(404).json({ error: 'Variant playlist not available' });
      return;
    }

    const variantParam = getParam(req, 'variant');
    const bitrateKbps = parseInt(variantParam.replace(/\.m3u8$/i, ''), 10);
    if (!Number.isInteger(bitrateKbps) || bitrateKbps <= 0) {
      res.status(400).json({ error: 'Invalid variant' });
      return;
    }

    if (!upload.hls.some((rendition) => rendition.bitrateKbps === bitrateKbps)) {
      res.status(404).json({ error: `No rendition at ${bitrateKbps} kbps` });
      return;
    }

    // Enforced server-side even though the locker ladder has a single rung: the
    // cap lives in the token, and a tampered client must not be able to ask for
    // more than the token it was given allows.
    if (bitrateKbps > access.maxBitrateKbps) {
      res.status(403).json({ error: 'Quality not permitted' });
      return;
    }

    const token = resolveManifestToken(req, uploadId, access.ownerOxyUserId, access.maxBitrateKbps);
    const playlist = await buildVariantPlaylistFor(
      { id: uploadId, hls: upload.hls },
      {
        bitrateKbps,
        token,
        baseUrl: env.STREAM_KEY_BASE_URL,
        basePath: `/api/uploads/${uploadId}/stream`,
      },
    );

    res.set('Content-Type', CONTENT_TYPE_HLS_PLAYLIST);
    res.set('Cache-Control', CACHE_CONTROL_PRIVATE_SHORT);
    res.set('Vary', 'Authorization');
    res.status(200).send(playlist);
  } catch (error) {
    next(error);
  }
};

/**
 * The token to embed in manifest URLs: reuse the caller's `?t=` when it has one
 * (native players carry it through every sub-request), otherwise mint a fresh one
 * for a bearer request.
 */
function resolveManifestToken(
  req: AuthRequest,
  uploadId: string,
  ownerOxyUserId: string,
  maxBitrateKbps: number,
): string {
  const rawToken = req.query?.t;
  if (typeof rawToken === 'string' && rawToken) return rawToken;
  return mintStreamToken(
    { trackId: uploadId, userId: ownerOxyUserId, maxBitrateKbps },
    LOCKER_STREAM_SESSION_TTL_SEC,
  );
}
