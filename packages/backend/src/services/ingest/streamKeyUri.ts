/**
 * Build the absolute (or relative fallback) URI for the HLS AES-128 key endpoint.
 *
 * This value is baked into every HLS playlist at packaging time and is therefore
 * IMMUTABLE per track once packaged. hls.js resolves relative key URIs against
 * the CDN manifest host, which would be wrong for a protected API endpoint.
 *
 * Set STREAM_KEY_BASE_URL (e.g. "https://api.syra.fm") in the environment.
 * If unset, falls back to the relative path (useful during local development).
 */
export function buildStreamKeyUri(trackId: string): string {
  return buildStreamKeyUriFor(`/api/stream/${trackId}`);
}

/**
 * Build the key URI for any streamable entity given its API base path
 * (e.g. `/api/stream/<trackId>` or `/api/podcasts/episodes/<episodeId>`). The
 * `/key` endpoint is appended. Shared by track and episode HLS packaging so the
 * key-endpoint logic is never duplicated.
 */
export function buildStreamKeyUriFor(entityBasePath: string): string {
  const base = process.env.STREAM_KEY_BASE_URL ?? '';
  return `${base}${entityBasePath}/key`;
}
