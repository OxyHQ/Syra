import type { CatalogSource, ExternalTrack, TrackImage } from '@syra/shared-types';
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
  isrc?: string;
  user: { id: string; name: string; profile_picture?: AudiusArtwork | null };
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
    if (typeof url === 'string' && url.length > 0) {
      images.push({ url, width, height, source: 'audius' as CatalogSource });
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

      // Skip inaccessible or unusable tracks
      if (item.is_delete) continue;
      if (!item.is_streamable) continue;
      if (item.is_stream_gated) continue;
      if (!item.title.trim()) continue;

      const streamUrl =
        `${this.apiBase}/v1/tracks/${item.id}/stream` +
        `?app_name=${encodeURIComponent(this.appName)}`;

      const artistImages = mapArtwork(item.user.profile_picture ?? null);

      const track: ExternalTrack = {
        provider: 'audius',
        externalId: String(item.id),
        title: item.title,
        durationSec: item.duration,
        artists: [
          {
            name: item.user.name,
            externalId: String(item.user.id),
            ...(artistImages !== undefined && { images: artistImages }),
          },
        ],
        streamUrl,
        ...(item.isrc !== undefined && { isrc: item.isrc }),
        ...(mapArtwork(item.artwork) !== undefined && { images: mapArtwork(item.artwork) }),
      };

      results.push(track);
    }

    return results;
  }
}
