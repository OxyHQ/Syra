import type {
  CatalogSource,
  ExternalAlbum,
  ExternalPlaylist,
  ExternalPopularity,
  ExternalTrack,
  TrackImage,
} from '@syra/shared-types';
import type { HttpGetJson, MusicSourceConnector } from './MusicSourceConnector';

export const AUDIUS_DEFAULT_API_BASE = 'https://discoveryprovider.audius.co';
export const AUDIUS_DEFAULT_APP_NAME = 'Syra';

async function defaultHttpGet(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Audius HTTP ${r.status}`);
  return r.json();
}

// ── Audius API shapes ─────────────────────────────────────────────────────────

/** Artwork object as returned by the Audius search endpoint. */
interface AudiusArtwork {
  '150x150'?: string;
  '480x480'?: string;
  '1000x1000'?: string;
}

/** Shape of a single Audius track from /v1/tracks/search. */
interface AudiusTrack {
  id: string;
  title: string;
  duration: number;
  is_delete: boolean;
  is_streamable: boolean;
  is_stream_gated: boolean;
  isrc?: string | null;
  genre?: string | null;
  mood?: string | null;
  tags?: string | null;
  release_date?: string | null;
  play_count?: number | null;
  favorite_count?: number | null;
  repost_count?: number | null;
  user: { id: string; name: string; profile_picture?: AudiusArtwork | null };
  artwork: AudiusArtwork | null;
  album?: {
    id?: string | number | null;
    playlist_id?: string | number | null;
    playlist_name?: string | null;
    name?: string | null;
    release_date?: string | null;
    artwork?: AudiusArtwork | null;
  } | null;
}

/** Shape of a single Audius album from /v1/users/{id}/albums. */
interface AudiusAlbum {
  id: string;
  playlist_name: string;
  is_album?: boolean;
  is_delete?: boolean;
  release_date?: string | null;
  total_play_count?: number | null;
  favorite_count?: number | null;
  repost_count?: number | null;
  upc?: string | null;
  artwork: AudiusArtwork | null;
}

/**
 * Type guard — confirms `value` has the minimum required fields of AudiusTrack.
 * Malformed items are skipped rather than throwing.
 */
function isAudiusTrack(value: unknown): value is AudiusTrack {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['title'] === 'string' &&
    typeof v['duration'] === 'number' &&
    typeof v['is_delete'] === 'boolean' &&
    typeof v['is_streamable'] === 'boolean' &&
    typeof v['is_stream_gated'] === 'boolean' &&
    typeof v['user'] === 'object' &&
    v['user'] !== null &&
    typeof (v['user'] as Record<string, unknown>)['id'] === 'string' &&
    typeof (v['user'] as Record<string, unknown>)['name'] === 'string'
  );
}

/**
 * Type guard — confirms `value` has the minimum required fields of AudiusAlbum.
 */
function isAudiusAlbum(value: unknown): value is AudiusAlbum {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && typeof v['playlist_name'] === 'string';
}

// ── Field normalisers ─────────────────────────────────────────────────────────

/** Trim a nullable string, returning undefined for empty/blank/missing values. */
function cleanString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Split a comma-separated tags string into a trimmed, de-blanked array. */
function parseTags(tags: string | null | undefined): string[] | undefined {
  if (typeof tags !== 'string') return undefined;
  const parsed = tags
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return parsed.length > 0 ? parsed : undefined;
}

/** Keep only finite non-negative numbers; everything else → undefined. */
function cleanCount(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Build an ExternalPopularity from raw play/favorite/repost counts. Returns
 * undefined when the provider exposes none of them (so we never write zeros
 * that would clobber a real value on merge).
 */
function buildPopularity(
  playCount: number | null | undefined,
  favoriteCount: number | null | undefined,
  repostCount: number | null | undefined,
): ExternalPopularity | undefined {
  const play = cleanCount(playCount);
  const favorite = cleanCount(favoriteCount);
  const repost = cleanCount(repostCount);
  if (play === undefined && favorite === undefined && repost === undefined) {
    return undefined;
  }
  return {
    ...(play !== undefined && { playCount: play }),
    ...(favorite !== undefined && { favoriteCount: favorite }),
    ...(repost !== undefined && { repostCount: repost }),
  };
}

function mapAudiusTrack(
  item: AudiusTrack,
  apiBase: string,
  appName: string,
): ExternalTrack | null {
  if (item.is_delete) return null;
  if (!item.is_streamable) return null;
  if (item.is_stream_gated) return null;
  if (!item.title.trim()) return null;

  const streamUrl =
    `${apiBase}/v1/tracks/${item.id}/stream` +
    `?app_name=${encodeURIComponent(appName)}`;

  const artistImages = mapArtwork(item.user.profile_picture ?? null);
  const trackImages = mapArtwork(item.artwork);
  if (!artistImages?.length || !trackImages?.length) return null;

  const isrc = cleanString(item.isrc);
  const genre = cleanString(item.genre);
  const mood = cleanString(item.mood);
  const tags = parseTags(item.tags);
  const releaseDate = cleanString(item.release_date);
  const album = mapTrackAlbum(item);
  const popularity = buildPopularity(
    item.play_count,
    item.favorite_count,
    item.repost_count,
  );

  return {
    provider: 'audius',
    externalId: String(item.id),
    title: item.title,
    durationSec: item.duration,
    artists: [
      {
        name: item.user.name,
        externalId: String(item.user.id),
        images: artistImages,
      },
    ],
    streamUrl,
    ...(isrc !== undefined && { isrc }),
    images: trackImages,
    ...(album !== undefined && { album }),
    ...(genre !== undefined && { genre }),
    ...(mood !== undefined && { mood }),
    ...(tags !== undefined && { tags }),
    ...(releaseDate !== undefined && { releaseDate }),
    ...(popularity !== undefined && { popularity }),
  };
}

function mapTrackAlbum(item: AudiusTrack): ExternalAlbum | undefined {
  const rawAlbum = item.album;
  if (!rawAlbum) return undefined;

  const rawId = rawAlbum.id ?? rawAlbum.playlist_id;
  const name = cleanString(rawAlbum.playlist_name) ?? cleanString(rawAlbum.name);
  if (rawId === null || rawId === undefined || !name) return undefined;

  const images = mapArtwork(rawAlbum.artwork ?? item.artwork);
  const releaseDate = cleanString(rawAlbum.release_date) ?? cleanString(item.release_date);
  const genre = cleanString(item.genre);

  return {
    name,
    externalId: String(rawId),
    trackExternalIds: [String(item.id)],
    ...(images !== undefined && { images }),
    ...(releaseDate !== undefined && { releaseDate }),
    ...(genre !== undefined && { genre }),
  };
}

// ── Artwork → TrackImage[] ────────────────────────────────────────────────────

// Ordered largest-first so images[0] is the highest-resolution variant.
// firstImageUrl() picks images[0], so this determines the default display quality.
const ARTWORK_SIZES: Array<{ key: keyof AudiusArtwork; width: number; height: number }> = [
  { key: '1000x1000', width: 1000, height: 1000 },
  { key: '480x480', width: 480, height: 480 },
  { key: '150x150', width: 150, height: 150 },
];

function mapArtwork(artwork: AudiusArtwork | null): TrackImage[] | undefined {
  if (!artwork) return undefined;

  const images: TrackImage[] = [];
  for (const { key, width, height } of ARTWORK_SIZES) {
    const url = artwork[key];
    if (typeof url === 'string' && url.trim().length > 0) {
      images.push({ url: url.trim(), width, height, source: 'audius' as CatalogSource });
    }
  }
  return images.length > 0 ? images : undefined;
}

// ── Connector ─────────────────────────────────────────────────────────────────

export interface AudiusConnectorDeps {
  httpGet?: HttpGetJson;
  apiBase?: string;
  appName?: string;
}

/**
 * Audius search connector — stream-only.
 *
 * Audius tracks are served directly from Audius infrastructure via the stream
 * URL; we never re-host the audio. The `streamUrl` in the normalised
 * `ExternalTrack` is passed through to the client as-is so playback goes
 * directly to the Audius discovery node.
 *
 * Tracks are skipped when:
 *   - `is_delete === true`     — removed by the artist
 *   - `is_streamable === false` — not available for streaming
 *   - `is_stream_gated === true` — requires wallet signature (unusable for us)
 *   - `title` is blank after trim — unusable junk; would display as "No track selected"
 */
export class AudiusConnector implements MusicSourceConnector {
  readonly provider = 'audius' as const;

  private readonly httpGet: HttpGetJson;
  private readonly apiBase: string;
  private readonly appName: string;

  constructor(deps: AudiusConnectorDeps = {}) {
    this.httpGet = deps.httpGet ?? defaultHttpGet;
    this.apiBase = deps.apiBase ?? process.env.AUDIUS_API_URL ?? AUDIUS_DEFAULT_API_BASE;
    this.appName = deps.appName ?? process.env.AUDIUS_APP_NAME ?? AUDIUS_DEFAULT_APP_NAME;
  }

  async search(query: string, limit: number = 20): Promise<ExternalTrack[]> {
    const url =
      `${this.apiBase}/v1/tracks/search` +
      `?query=${encodeURIComponent(query)}` +
      `&app_name=${encodeURIComponent(this.appName)}` +
      `&limit=${limit}`;

    const raw = await this.httpGet(url);

    // Defensive parse — unknown response shape must not throw
    if (typeof raw !== 'object' || raw === null) return [];
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body['data'])) return [];

    const results: ExternalTrack[] = [];

    for (const item of body['data']) {
      if (!isAudiusTrack(item)) continue;

      const track = mapAudiusTrack(item, this.apiBase, this.appName);
      if (track) results.push(track);
    }

    return results;
  }

  /**
   * Fetch the albums published by an Audius artist, normalised to ExternalAlbum.
   *
   * For each album we additionally fetch its track listing so the importer can
   * upsert and link every member track. A failed track-listing fetch degrades
   * gracefully to an empty `trackExternalIds`; the catalog layer will skip the
   * album rather than persist an empty container.
   *
   * Non-album playlists (`is_album === false`) and deleted albums are skipped.
   * A malformed albums response yields `[]` rather than throwing.
   */
  async fetchArtistAlbums(artistExternalId: string, limit: number = 20): Promise<ExternalAlbum[]> {
    const url =
      `${this.apiBase}/v1/users/${encodeURIComponent(artistExternalId)}/albums` +
      `?app_name=${encodeURIComponent(this.appName)}` +
      `&limit=${limit}`;

    const raw = await this.httpGet(url);

    if (typeof raw !== 'object' || raw === null) return [];
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body['data'])) return [];

    const albums: ExternalAlbum[] = [];

    for (const item of body['data']) {
      if (!isAudiusAlbum(item)) continue;
      if (item.is_album === false) continue;
      if (item.is_delete === true) continue;
      if (!item.playlist_name.trim()) continue;

      const trackListing = await this.fetchPlaylistTrackListing(item.id);
      // The album genre is not on the album payload itself; inherit it from the
      // first member track that carries one (matches how Audius surfaces genre).
      const genre = trackListing.genre;

      const images = mapArtwork(item.artwork);
      if (!images?.length) continue;
      const releaseDate = cleanString(item.release_date);
      const popularity = buildPopularity(
        item.total_play_count,
        item.favorite_count,
        item.repost_count,
      );

      const album: ExternalAlbum = {
        name: item.playlist_name,
        externalId: String(item.id),
        trackExternalIds: trackListing.ids,
        tracks: trackListing.tracks,
        images,
        ...(releaseDate !== undefined && { releaseDate }),
        ...(genre !== undefined && { genre }),
        ...(popularity !== undefined && { popularity }),
      };

      albums.push(album);
    }

    return albums;
  }

  /**
   * Fetch non-album playlists published by an Audius artist.
   */
  async fetchArtistPlaylists(
    artistExternalId: string,
    limit: number = 20,
  ): Promise<ExternalPlaylist[]> {
    const url =
      `${this.apiBase}/v1/users/${encodeURIComponent(artistExternalId)}/playlists` +
      `?app_name=${encodeURIComponent(this.appName)}` +
      `&limit=${limit}`;

    const raw = await this.httpGet(url);

    if (typeof raw !== 'object' || raw === null) return [];
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body['data'])) return [];

    const playlists: ExternalPlaylist[] = [];

    for (const item of body['data']) {
      if (!isAudiusAlbum(item)) continue;
      if (item.is_album === true) continue;
      if (item.is_delete === true) continue;
      if (!item.playlist_name.trim()) continue;

      const trackListing = await this.fetchPlaylistTrackListing(item.id);
      const images = mapArtwork(item.artwork);
      if (!images?.length) continue;
      const popularity = buildPopularity(
        item.total_play_count,
        item.favorite_count,
        item.repost_count,
      );

      playlists.push({
        name: item.playlist_name,
        externalId: String(item.id),
        trackExternalIds: trackListing.ids,
        tracks: trackListing.tracks,
        images,
        ...(trackListing.genre !== undefined && { genre: trackListing.genre }),
        ...(popularity !== undefined && { popularity }),
      });
    }

    return playlists;
  }

  /**
   * Fetch the ordered external tracks for an Audius playlist/album, plus the
   * genre of the first track that carries one. Network/parse failures degrade
   * to empty.
   */
  private async fetchPlaylistTrackListing(
    playlistExternalId: string,
  ): Promise<{ ids: string[]; tracks: ExternalTrack[]; genre: string | undefined }> {
    const url =
      `${this.apiBase}/v1/playlists/${encodeURIComponent(playlistExternalId)}/tracks` +
      `?app_name=${encodeURIComponent(this.appName)}`;

    let raw: unknown;
    try {
      raw = await this.httpGet(url);
    } catch {
      // The connector remains best-effort; catalog persistence decides whether
      // an empty track listing is usable.
      return { ids: [], tracks: [], genre: undefined };
    }

    if (typeof raw !== 'object' || raw === null) return { ids: [], tracks: [], genre: undefined };
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body['data'])) return { ids: [], tracks: [], genre: undefined };

    const ids: string[] = [];
    const tracks: ExternalTrack[] = [];
    let genre: string | undefined;
    for (const item of body['data']) {
      if (!isAudiusTrack(item)) continue;
      const track = mapAudiusTrack(item, this.apiBase, this.appName);
      if (!track) continue;
      ids.push(track.externalId);
      tracks.push(track);
      if (genre === undefined) genre = track.genre;
    }

    return { ids, tracks, genre };
  }
}
