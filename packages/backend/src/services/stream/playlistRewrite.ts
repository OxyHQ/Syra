/**
 * Pure HLS variant playlist rewriter — no I/O, no side effects.
 *
 * The master playlist is now built directly from `track.hls` in `manifestService`
 * (no S3 fetch, filtered by the user's bitrate cap). This module handles only
 * variant playlist rewriting:
 *  - Segment filenames → presigned S3 URLs.
 *  - EXT-X-KEY URI → tokenized key endpoint (METHOD and IV preserved).
 */

// ── Variant playlist ──────────────────────────────────────────────────────────

export interface RewriteVariantOpts {
  trackId: string;
  token: string;
  baseUrl: string;
  /**
   * API base path of the streamable entity, used to build the `EXT-X-KEY` URI as
   * `${baseUrl}${keyBasePath}/key?t=${token}`. Defaults to `/api/stream/${trackId}`
   * so track playlists are unchanged; episodes pass `/api/podcasts/episodes/<id>`.
   */
  keyBasePath?: string;
  /** Called with the bare segment filename (e.g. `segment-0.ts`); returns a presigned URL. */
  presign: (segmentName: string) => Promise<string>;
}

/**
 * Rewrite a variant HLS playlist:
 *  - `#EXT-X-KEY` line: only the URI attribute is rewritten to the tokenized key
 *    endpoint; METHOD and IV are preserved exactly as-is.
 *  - Non-comment, non-tag lines (segment filenames): replaced with presigned S3 URLs.
 *  - All other lines (#EXTINF, #EXTM3U, etc.) are left untouched.
 */
export async function rewriteVariantPlaylist(
  text: string,
  opts: RewriteVariantOpts,
): Promise<string> {
  const { trackId, token, baseUrl, presign } = opts;
  const keyBasePath = opts.keyBasePath ?? `/api/stream/${trackId}`;
  const keyUrl = `${baseUrl}${keyBasePath}/key?t=${token}`;

  const rewrittenLines = await Promise.all(
    text.split('\n').map(async (line) => {
      const trimmed = line.trim();

      // Rewrite EXT-X-KEY URI only — keep METHOD and IV intact
      if (trimmed.startsWith('#EXT-X-KEY:')) {
        // Focused regex: swap only the URI="..." attribute value
        return line.replace(/URI="[^"]*"/, `URI="${keyUrl}"`);
      }

      // Leave all other tag lines and empty lines untouched
      if (!trimmed || trimmed.startsWith('#')) return line;

      // Segment filename — replace with presigned URL
      return presign(trimmed);
    }),
  );

  return rewrittenLines.join('\n');
}
