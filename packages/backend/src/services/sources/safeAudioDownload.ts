/**
 * Safe audio download helpers for the CC import pipeline.
 *
 * CC tracks are downloaded from externally-controlled URLs (Jamendo, etc.)
 * before being re-hosted on Syra's S3. Without guards, the download path is
 * vulnerable to SSRF (fetching internal metadata endpoints or RFC-1918 hosts),
 * unbounded memory growth (no content-length cap), and content smuggling
 * (a server returning HTML instead of audio).
 *
 * These helpers are pure (no I/O) so they are fully testable without network.
 */

import { validateUrlLength, validateUrlSecurity } from '../../utils/urlSecurity';

/** Hard cap on downloadable audio size. Prevents OOM from hostile servers. */
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Specific audio MIME types that, on their own, are sufficient to accept a
 * response as audio. `application/octet-stream` is intentionally excluded:
 * it is a generic catch-all that any server can emit regardless of content, so
 * octet-stream responses must pass the magic-byte check below instead.
 */
export const ALLOWED_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
]);

/**
 * Assert that the URL is safe to fetch.
 *
 * Guards against:
 *  - URLs exceeding the 2048-char length limit (DoS via redirect-chain memory).
 *  - Non-HTTP/HTTPS protocols (file://, gopher://, etc.).
 *  - Localhost, loopback, RFC-1918, link-local, and other private ranges (SSRF).
 *
 * Throws a descriptive Error on the first failing check. Pure — no network.
 */
export function assertSafeAudioUrl(url: string): void {
  if (!validateUrlLength(url)) {
    throw new Error(`audio url exceeds maximum length: ${url.length} chars`);
  }

  const result = validateUrlSecurity(url);
  if (!result.valid) {
    throw new Error(`unsafe audio url: ${result.error}`);
  }
}

/**
 * Return true if the buffer and content-type look like real audio.
 *
 * Checks (in order, short-circuit on first match):
 *  1. Content-Type in ALLOWED_AUDIO_MIME (specific audio/* types only — NOT
 *     application/octet-stream, which is generic and must fall through to bytes).
 *  2. ID3 magic bytes: `ID3` at offset 0 (MP3 with ID3v2 tag).
 *  3. MP3 frame-sync: `0xFF` at offset 0, bits 5-7 of offset 1 all set (`0xE0`).
 *  4. MP4/M4A ftyp box: ASCII `ftyp` at bytes 4–8.
 *
 * Returns false for empty buffers, HTML, JSON, octet-stream without audio magic,
 * or unrecognised byte patterns. Pure — no I/O.
 */
export function isLikelyAudio(buffer: Buffer, contentType: string | null): boolean {
  // 1. Content-Type check
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (ALLOWED_AUDIO_MIME.has(mime)) return true;
  }

  if (buffer.length < 4) return false;

  // 2. ID3 magic: 'I' 'D' '3'
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;

  // 3. MP3 frame sync: 0xFF followed by a byte with bits 5-7 set (0xE0 mask)
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;

  // 4. MP4/M4A ftyp box: bytes 4–8 are ASCII 'ftyp'
  if (buffer.length >= 8) {
    const maybeFtyp = buffer.toString('ascii', 4, 8);
    if (maybeFtyp === 'ftyp') return true;
  }

  return false;
}
