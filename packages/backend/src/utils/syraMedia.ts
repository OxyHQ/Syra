import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from './logger';
import { TrackModel, ITrack } from '../models/Track';
import { getTrackStreamUrl } from '../services/audioStorageService';
import { mintStreamToken } from '../services/stream/streamToken';
import { isTrackPlayable } from '../controllers/stream.controller';
import { playableTrackFilter } from '../utils/catalogVisibility';
import { formatTrackWithCoverArt } from '../utils/musicHelpers';
import { PlaylistTrackModel } from '../models/PlaylistTrack';
import type { MediaQueueItem } from '../models/Room';

/**
 * Syra MUSIC → live-room ingress resolver — the music-shaped sibling of
 * {@link ../utils/syraPodcast.ts `resolvePodcastEpisode`}. Turns an opaque track
 * id (or an album / playlist id) into the playable audio + "now playing"
 * metadata the LiveKit URL-ingress path consumes, entirely server-side. The
 * client NEVER supplies the audio URL — it hands us only ids.
 *
 * COPYRIGHT / LICENSING NOTE: streaming a full track into a live room is a
 * *broadcast* / public performance, NOT a private listen. This is intentionally
 * scoped to Syra's OWN catalog (uploads and Creative-Commons imports —
 * all carrying a permissive rights model), and the host is shown a rights
 * disclaimer in the picker before starting a listening party. Do NOT extend this
 * to arbitrary third-party catalog URLs without a broadcast license.
 */

// ── Audio-URL selection ────────────────────────────────────────────────────────

/**
 * HLS token cap. HLS URL ingress rewrites variant/key sub-URLs to embed
 * self-authorized `?t=` tokens, so a single high-cap session token is minted for
 * the whole ladder. `userId: ''` marks a server-owned (room) session — the token
 * is bound to the trackId, which is all the stream endpoints verify.
 */
const HLS_STREAM_TOKEN_CAP_KBPS = 320;
const HLS_STREAM_TOKEN_TTL_SEC = 3600;

/** Minimal raw-track shape needed to pick a playable audio URL. */
type PlayableTrackFields = Pick<
  ITrack,
  'audioSource' | 'artistId' | 'albumId' | 'title' | 'hlsMasterKey' | 'hls' | 'source' | 'status'
> & { _id: mongoose.Types.ObjectId; isAvailable?: boolean; copyrightRemoved?: boolean };

type AudioUrlOutcome =
  | { status: 'ok'; audioUrl: string }
  | { status: 'none' }
  | { status: 'unavailable' };

/**
 * Pick the best ingress audio URL for a track, in preference order:
 *   1. Presigned original file (`getTrackStreamUrl`) — the raw mp3/flac, DRM-free
 *      (uploads / CC). The podcast-`enclosureUrl` equivalent; PREFERRED.
 *   2. Tokenized HLS master — for tracks with only an encrypted HLS ladder.
 *      Requires an absolute `STREAM_KEY_BASE_URL` (LiveKit + the SSRF probe need
 *      a public URL) and a mintable stream token.
 *
 * `none` when the track is playable but carries no usable source (a data gap);
 * `unavailable` when a source exists but producing its URL threw (S3 / token
 * error) — a transient failure the caller maps to 503, never "not found".
 */
async function resolveTrackAudioUrl(track: PlayableTrackFields): Promise<AudioUrlOutcome> {
  const trackId = track._id.toString();
  let transient = false;

  // 1. Presigned original file (uploads / CC).
  if (track.audioSource) {
    try {
      const audioUrl = await getTrackStreamUrl({
        id: trackId,
        artistId: track.artistId,
        albumId: track.albumId,
        title: track.title,
        audioSource: track.audioSource,
      });
      return { status: 'ok', audioUrl };
    } catch (err) {
      transient = true;
      logger.warn('[SyraMedia] Presigned original URL failed', {
        trackId,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  // 2. Tokenized HLS master — only usable as an absolute, public URL.
  const base = env.STREAM_KEY_BASE_URL;
  if (base && track.status === 'ready' && track.hlsMasterKey && Array.isArray(track.hls) && track.hls.length > 0) {
    try {
      const token = mintStreamToken(
        { trackId, userId: '', maxBitrateKbps: HLS_STREAM_TOKEN_CAP_KBPS },
        HLS_STREAM_TOKEN_TTL_SEC,
      );
      return { status: 'ok', audioUrl: `${base}/api/stream/${trackId}/master.m3u8?t=${token}` };
    } catch (err) {
      transient = true;
      logger.warn('[SyraMedia] HLS master token mint failed', {
        trackId,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return { status: transient ? 'unavailable' : 'none' };
}

// ── Absolute cover art ─────────────────────────────────────────────────────────

/**
 * `formatTrackWithCoverArt` yields a RELATIVE `/api/images/:id` cover path. The
 * "now playing" card renders on foreign clients, so promote it to an absolute
 * Syra API URL when `STREAM_KEY_BASE_URL` is configured; otherwise leave it
 * relative (local dev) or drop non-image values.
 */
function toAbsoluteArtworkUrl(coverArt: unknown): string | undefined {
  if (typeof coverArt !== 'string' || !coverArt) return undefined;
  const base = env.STREAM_KEY_BASE_URL;
  if (base && coverArt.startsWith('/')) return `${base}${coverArt}`;
  return coverArt;
}

// ── Single-track resolve ───────────────────────────────────────────────────────

/**
 * The server-resolved playable form of a track. `audioUrl` is fed straight into
 * the LiveKit URL ingress; the rest denormalizes the "now playing" card.
 */
export interface ResolvedTrack {
  audioUrl: string;
  title: string;
  artist?: string;
  artworkUrl?: string;
  durationSec?: number;
}

/**
 * Tri-state outcome of {@link resolveTrack}, mirroring
 * {@link ../utils/syraPodcast.ts `ResolvePodcastEpisodeResult`}: a genuine
 * "no such playable track" (404 at the route) is kept distinct from a transient
 * storage/token failure (503, retryable) so the two are never conflated.
 */
export type ResolveTrackResult =
  | { status: 'ok'; track: ResolvedTrack }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/**
 * Resolve a single Syra track by id into its playable {@link ResolvedTrack},
 * denormalized from the catalog — the client never supplies the audio URL.
 *
 *  - `not_found` — bad id, the track is missing, not playable
 *    (`isTrackPlayable`), not `ready`, or carries no usable audio source.
 *  - `unavailable` — a source exists but producing its URL threw (S3 presign /
 *    token mint) — a transient failure to retry, not a missing track.
 *  - `ok` — the resolved, playable track.
 *
 * Never throws.
 */
export async function resolveTrack(trackId: string): Promise<ResolveTrackResult> {
  if (!mongoose.Types.ObjectId.isValid(trackId)) {
    return { status: 'not_found' };
  }

  const track = await TrackModel.findById(trackId).lean();
  if (!track || !isTrackPlayable(track) || track.status !== 'ready') {
    return { status: 'not_found' };
  }

  const audio = await resolveTrackAudioUrl(track);
  if (audio.status === 'none') {
    return { status: 'not_found' };
  }
  if (audio.status === 'unavailable') {
    return { status: 'unavailable' };
  }

  const formatted = await formatTrackWithCoverArt(track);
  return {
    status: 'ok',
    track: {
      audioUrl: audio.audioUrl,
      title: typeof formatted?.title === 'string' ? formatted.title : track.title,
      artist: typeof formatted?.artistName === 'string' ? formatted.artistName : track.artistName,
      artworkUrl: toAbsoluteArtworkUrl(formatted?.coverArt),
      durationSec: typeof track.duration === 'number' ? track.duration : undefined,
    },
  };
}

// ── Album / playlist queue seeding ─────────────────────────────────────────────

/**
 * Ordered list of Syra tracks in an album as {@link MediaQueueItem} queue rows
 * (`kind: 'track'`, id only) — audio is resolved per item at play-time, exactly
 * like the podcast queue stores episode ids, never URLs. Uses the SAME
 * playable-track filter + ordering as the public `GET /albums/:id/tracks`
 * endpoint. Returns an empty array for a missing album or one with no playable
 * tracks; the route treats an empty seed as `not_found`.
 */
export async function resolveAlbumTracks(albumId: string): Promise<MediaQueueItem[]> {
  if (!mongoose.Types.ObjectId.isValid(albumId)) return [];

  const tracks = await TrackModel.find(playableTrackFilter({ albumId }))
    .sort({ discNumber: 1, trackNumber: 1 })
    .select({ _id: 1 })
    .lean();

  return tracks.map((track) => ({ kind: 'track', trackId: track._id.toString() }));
}

/**
 * Ordered list of a playlist's Syra tracks as {@link MediaQueueItem} queue rows
 * (`kind: 'track'`, id only). Mirrors the public `GET /playlists/:id/tracks`
 * ordering: `PlaylistTrack.order` is authoritative, and only tracks that pass the
 * playable filter are kept (dropped rows do not shift the surviving order).
 * Returns an empty array when the playlist is empty or has no playable tracks.
 */
export async function resolvePlaylistTracks(playlistId: string): Promise<MediaQueueItem[]> {
  if (!mongoose.Types.ObjectId.isValid(playlistId)) return [];

  const playlistTracks = await PlaylistTrackModel.find({ playlistId })
    .sort({ order: 1 })
    .lean();
  if (playlistTracks.length === 0) return [];

  const trackIds = playlistTracks.map((pt) => pt.trackId);
  const playable = await TrackModel.find(playableTrackFilter({ _id: { $in: trackIds } }))
    .select({ _id: 1 })
    .lean();
  const playableIds = new Set(playable.map((track) => track._id.toString()));

  const items: MediaQueueItem[] = [];
  for (const pt of playlistTracks) {
    if (playableIds.has(pt.trackId)) {
      items.push({ kind: 'track', trackId: pt.trackId });
    }
  }
  return items;
}
