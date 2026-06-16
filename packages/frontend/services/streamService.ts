import { api } from '@/utils/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StreamResolution {
  url: string;
  type: 'hls' | 'audius';
  expiresAt: string | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

/**
 * Resolve the stream URL for a track from the backend.
 *
 * Calls `GET /api/stream/:trackId` (bearer-authenticated) which returns the
 * resolved URL along with its type and optional expiry.
 *
 * - `type: 'hls'`    — API-served tokenized HLS master playlist.
 * - `type: 'audius'` — Direct Audius network stream URL.
 *
 * @throws Error on any network or API error, with a descriptive message
 *   including the trackId and the original error message.
 */
export async function resolveStream(trackId: string): Promise<StreamResolution> {
  try {
    const res = await api.get<StreamResolution>(`/stream/${trackId}`);
    return res.data;
  } catch (error) {
    throw new Error(
      `Failed to resolve stream for ${trackId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
