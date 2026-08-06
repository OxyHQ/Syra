import { and, asc, eq, sql } from 'drizzle-orm';
import { env } from '../config/env';
import { logger } from './logger';
import { getDb } from '../db/postgres';
import { albums, trackHlsRenditions, tracks } from '../db/schema/catalog';
import { playlistTracks } from '../db/schema/library';
import { playableTrackFilter } from '../db/catalog/visibility';
import { normalizeImageRef } from '../db/catalog/serialize';
import { getTrackStreamUrl } from '../services/audioStorageService';
import { mintStreamToken } from '../services/stream/streamToken';
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
 *
 * PORTED TO DRIZZLE (Task 10a). Its exported contract is unchanged — the same
 * three functions, the same tri-state result — so no caller moves. Three things
 * changed inside:
 *
 *  - Playability is applied in the WHERE clause via `playableTrackFilter()`
 *    rather than loading the row and re-checking it against `stream.controller`'s
 *    `isTrackPlayable`. One authority, asked once; an unplayable track never
 *    comes back.
 *  - The `ObjectId.isValid` pre-checks are gone. An id of any shape is answered
 *    by the query, and a guard that rejects a well-formed id it has not been
 *    taught about is a fail-open bug in a new costume. "No such row" is free.
 *  - `resolvePlaylistTracks` is one join rather than two round trips:
 *    `playlist_tracks.track_id` is a real foreign key now, so membership and
 *    playability are answered together.
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

/** The columns picking an ingress audio URL needs. */
interface PlayableTrackFields {
  readonly id: string;
  readonly title: string;
  readonly artistId: string;
  readonly albumId: string | null;
  readonly status: string;
  readonly audioSourceUrl: string | null;
  readonly audioSourceFormat: 'mp3' | 'flac' | 'ogg' | 'm4a' | 'wav' | null;
  readonly hlsMasterKey: string | null;
  readonly hlsRenditionCount: number;
}

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
  let transient = false;

  // 1. Presigned original file (uploads / CC).
  if (track.audioSourceUrl && track.audioSourceFormat) {
    try {
      const audioUrl = await getTrackStreamUrl({
        id: track.id,
        artistId: track.artistId,
        albumId: track.albumId ?? undefined,
        title: track.title,
        audioSource: { url: track.audioSourceUrl, format: track.audioSourceFormat },
      });
      return { status: 'ok', audioUrl };
    } catch (err) {
      transient = true;
      logger.warn('[SyraMedia] Presigned original URL failed', {
        trackId: track.id,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  // 2. Tokenized HLS master — only usable as an absolute, public URL.
  const base = env.STREAM_KEY_BASE_URL;
  if (base && track.status === 'ready' && track.hlsMasterKey && track.hlsRenditionCount > 0) {
    try {
      const token = mintStreamToken(
        { trackId: track.id, userId: '', maxBitrateKbps: HLS_STREAM_TOKEN_CAP_KBPS },
        HLS_STREAM_TOKEN_TTL_SEC,
      );
      return { status: 'ok', audioUrl: `${base}/api/stream/${track.id}/master.m3u8?t=${token}` };
    } catch (err) {
      transient = true;
      logger.warn('[SyraMedia] HLS master token mint failed', {
        trackId: track.id,
        reason: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return { status: transient ? 'unavailable' : 'none' };
}

// ── Absolute cover art ─────────────────────────────────────────────────────────

/**
 * Cover art resolves to a RELATIVE `/api/images/:id` path. The "now playing"
 * card renders on foreign clients, so promote it to an absolute Syra API URL
 * when `STREAM_KEY_BASE_URL` is configured; otherwise leave it relative (local
 * dev) or drop it.
 */
function toAbsoluteArtworkUrl(coverArt: string | undefined): string | undefined {
  if (!coverArt) return undefined;
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
 *  - `not_found` — bad id, the track is missing, not playable, not `ready`, or
 *    carries no usable audio source.
 *  - `unavailable` — a source exists but producing its URL threw (S3 presign /
 *    token mint) — a transient failure to retry, not a missing track.
 *  - `ok` — the resolved, playable track.
 *
 * Never throws.
 */
export async function resolveTrack(trackId: string): Promise<ResolveTrackResult> {
  const [track] = await getDb()
    .select({
      id: tracks.id,
      title: tracks.title,
      artistId: tracks.artistId,
      artistName: tracks.artistName,
      albumId: tracks.albumId,
      duration: tracks.duration,
      status: tracks.status,
      audioSourceUrl: tracks.audioSourceUrl,
      audioSourceFormat: tracks.audioSourceFormat,
      hlsMasterKey: tracks.hlsMasterKey,
      hlsRenditionCount: sql<number>`(
        select count(*)::int from ${trackHlsRenditions}
        where ${trackHlsRenditions.trackId} = ${tracks.id}
      )`,
      coverArtId: tracks.coverArtId,
      /**
       * The album's cover is the fallback when the track carries none of its
       * own — the same fallback the catalog serializer applies, resolved in this
       * query rather than as the per-track `AlbumModel.findById` behind a Map
       * cache that the Mongo version needed.
       */
      albumCoverArtId: albums.coverArtId,
    })
    .from(tracks)
    .leftJoin(albums, eq(albums.id, tracks.albumId))
    .where(and(eq(tracks.id, trackId), eq(tracks.status, 'ready'), playableTrackFilter()))
    .limit(1);

  if (!track) return { status: 'not_found' };

  const audio = await resolveTrackAudioUrl(track);
  if (audio.status === 'none') return { status: 'not_found' };
  if (audio.status === 'unavailable') return { status: 'unavailable' };

  return {
    status: 'ok',
    track: {
      audioUrl: audio.audioUrl,
      title: track.title,
      artist: track.artistName,
      artworkUrl: toAbsoluteArtworkUrl(
        normalizeImageRef(track.coverArtId) ?? normalizeImageRef(track.albumCoverArtId),
      ),
      durationSec: track.duration,
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
  const rows = await getDb()
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.albumId, albumId), playableTrackFilter()))
    .orderBy(asc(tracks.discNumber), asc(tracks.trackNumber));

  return rows.map((row) => ({ kind: 'track', trackId: row.id }));
}

/**
 * Ordered list of a playlist's Syra tracks as {@link MediaQueueItem} queue rows
 * (`kind: 'track'`, id only). Mirrors the public `GET /playlists/:id/tracks`
 * ordering: `playlist_tracks.position` is authoritative, and only tracks that
 * pass the playable filter are kept (dropped rows do not shift the surviving
 * order). Returns an empty array when the playlist is empty or has no playable
 * tracks.
 */
export async function resolvePlaylistTracks(playlistId: string): Promise<MediaQueueItem[]> {
  const rows = await getDb()
    .select({ id: tracks.id })
    .from(playlistTracks)
    .innerJoin(tracks, eq(tracks.id, playlistTracks.trackId))
    .where(and(eq(playlistTracks.playlistId, playlistId), playableTrackFilter()))
    .orderBy(asc(playlistTracks.position));

  return rows.map((row) => ({ kind: 'track', trackId: row.id }));
}
