import type { ExternalTrack } from '@syra/shared-types';
import type { HttpGetJson, MusicSourceConnector } from './MusicSourceConnector';
import { permitsCommercialUse } from './ccLicense';

export const JAMENDO_DEFAULT_API_BASE = 'https://api.jamendo.com/v3.0';

// ── HTTP default ──────────────────────────────────────────────────────────────

async function defaultHttpGet(url: string): Promise<unknown> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Jamendo HTTP ${r.status}`);
  return r.json();
}

// ── Jamendo API shapes ────────────────────────────────────────────────────────

/** Shape of a single Jamendo track from /v3.0/tracks/. */
interface JamendoTrack {
  id: string;
  name: string;
  duration: number;
  artist_id: string;
  artist_name: string;
  album_name: string | null;
  album_id: string | null;
  image: string | null;
  audiodownload: string;
  audiodownload_allowed: boolean;
  license_ccurl: string;
}

/**
 * Type guard — confirms `value` has the minimum required fields of JamendoTrack.
 * Malformed items are skipped rather than throwing.
 */
function isJamendoTrack(value: unknown): value is JamendoTrack {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['duration'] === 'number' &&
    typeof v['artist_id'] === 'string' &&
    typeof v['artist_name'] === 'string' &&
    typeof v['audiodownload'] === 'string' &&
    typeof v['audiodownload_allowed'] === 'boolean' &&
    typeof v['license_ccurl'] === 'string'
  );
}

// ── Connector ─────────────────────────────────────────────────────────────────

export interface CcConnectorDeps {
  httpGet?: HttpGetJson;
  clientId?: string;
  apiBase?: string;
}

/**
 * Creative Commons connector backed by the Jamendo API v3.0.
 *
 * Legal constraint: Syra re-hosts CC audio to S3 and serves it commercially.
 * Therefore only tracks with commercially-permitted CC licenses are included:
 *   - CC0, CC BY, CC BY-SA, CC BY-ND
 *
 * NonCommercial variants (BY-NC, BY-NC-SA, BY-NC-ND) are rejected by
 * `permitsCommercialUse` from the ccLicense module. Tracks that are not
 * downloadable (`audiodownload_allowed === false`) are also rejected since
 * we cannot re-host the audio.
 *
 * Unlike the Audius connector there is no `streamUrl` — the flow is:
 *   download via `audiodownload` → ingest → store on our S3 → serve via HLS.
 */
export class CcConnector implements MusicSourceConnector {
  readonly provider = 'cc' as const;

  private readonly httpGet: HttpGetJson;
  private readonly clientId: string | undefined;
  private readonly apiBase: string;

  constructor(deps: CcConnectorDeps = {}) {
    this.httpGet = deps.httpGet ?? defaultHttpGet;
    this.clientId = deps.clientId ?? process.env.JAMENDO_CLIENT_ID;
    this.apiBase = deps.apiBase ?? process.env.JAMENDO_API_URL ?? JAMENDO_DEFAULT_API_BASE;
  }

  async search(query: string, limit: number = 20): Promise<ExternalTrack[]> {
    if (!this.clientId) {
      throw new Error('JAMENDO_CLIENT_ID not set');
    }

    const url =
      `${this.apiBase}/tracks/` +
      `?client_id=${encodeURIComponent(this.clientId)}` +
      `&format=json` +
      `&search=${encodeURIComponent(query)}` +
      `&limit=${limit}` +
      `&include=licenses+musicinfo` +
      `&audioformat=mp32`;

    const raw = await this.httpGet(url);

    // Defensive parse — unknown response shape must not throw
    if (typeof raw !== 'object' || raw === null) return [];
    const body = raw as Record<string, unknown>;
    if (!Array.isArray(body['results'])) return [];

    const results: ExternalTrack[] = [];

    for (const item of body['results']) {
      if (!isJamendoTrack(item)) continue;

      // Legal filter: only commercially-permitted, downloadable tracks
      if (!permitsCommercialUse(item.license_ccurl)) continue;
      if (!item.audiodownload_allowed) continue;

      const track: ExternalTrack = {
        provider: 'cc',
        externalId: String(item.id),
        title: item.name,
        durationSec: item.duration,
        artists: [{ name: item.artist_name, externalId: String(item.artist_id) }],
        downloadUrl: item.audiodownload,
        license: item.license_ccurl,
        ...(item.album_name && item.album_id && {
          album: { name: item.album_name, externalId: String(item.album_id) },
        }),
        ...(item.image && {
          images: [{ url: item.image, source: 'cc' as const }],
        }),
      };

      results.push(track);
    }

    return results;
  }
}
