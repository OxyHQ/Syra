/**
 * Pure HLS playlist rewriters — no I/O, no side effects.
 *
 * Master playlist: variant paths (e.g. `96/stream.m3u8`) are replaced with
 * tokenized API URLs so the player fetches them through our auth layer.
 *
 * Variant playlist: segment filenames are replaced with presigned S3 URLs and
 * the EXT-X-KEY URI is swapped to our authenticated key endpoint. METHOD and IV
 * are preserved unchanged.
 */

// ── Master playlist ───────────────────────────────────────────────────────────

export interface RewriteMasterOpts {
  trackId: string;
  token: string;
  baseUrl: string;
}

/**
 * Rewrite a master HLS playlist so every variant path becomes a tokenized API
 * URL of the form `${baseUrl}/api/stream/${trackId}/v/${bitrateKbps}.m3u8?t=${token}`.
 *
 * A variant path is any non-comment, non-empty line (i.e. not starting with `#`).
 * The bitrate is extracted from the leading directory segment (e.g. `96/stream.m3u8` → `96`).
 * Tag lines (`#EXT-X-STREAM-INF`, `#EXTM3U`, etc.) are left untouched.
 */
export function rewriteMasterPlaylist(text: string, opts: RewriteMasterOpts): string {
  const { trackId, token, baseUrl } = opts;

  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      // Extract bitrate from leading directory: "96/stream.m3u8" → "96"
      const slash = trimmed.indexOf('/');
      const bitrate = slash !== -1 ? trimmed.slice(0, slash) : trimmed;

      return `${baseUrl}/api/stream/${trackId}/v/${bitrate}.m3u8?t=${token}`;
    })
    .join('\n');
}

// ── Variant playlist ──────────────────────────────────────────────────────────

export interface RewriteVariantOpts {
  trackId: string;
  token: string;
  baseUrl: string;
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
  const keyUrl = `${baseUrl}/api/stream/${trackId}/key?t=${token}`;

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
