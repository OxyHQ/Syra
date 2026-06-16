/**
 * ACRCloud audio fingerprinting integration.
 *
 * ACRCloud (https://www.acrcloud.com) identifies commercial recordings from
 * raw audio by comparing against their database of 100M+ tracks.
 *
 * CURRENT STATE: STUB. The interface is production-ready so the real
 * integration is a drop-in replacement. No network I/O is performed until the
 * real implementation lands.
 *
 * FUTURE IMPLEMENTATION — /v1/identify endpoint:
 * POST https://{ACRCLOUD_HOST}/v1/identify
 * Content-Type: multipart/form-data
 * Required fields:
 *   - access_key: string
 *   - sample: audio Buffer (the raw PCM/MP3 excerpt, typically 10–20s)
 *   - sample_bytes: number (byte length of sample)
 *   - timestamp: unix seconds (string)
 *   - signature: HMAC-SHA1(
 *       "POST\n/v1/identify\n{access_key}\naudio\n1\n{timestamp}",
 *       ACRCLOUD_ACCESS_SECRET
 *     ) |> base64
 *   - data_type: "audio"
 *   - signature_version: "1"
 * Response (200): { status: { code: 0|1001, msg: ... }, metadata?: { music?: [...] } }
 *   code 0 = match found; 1001 = no result
 * Each match entry has: title, artists[].name, external_ids?.isrc, score (0-100)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FingerprintMatch {
  matched: boolean;
  title?: string;
  artist?: string;
  isrc?: string;
  /** Confidence score normalised to 0–1 */
  confidence?: number;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Return true when all three ACRCloud credentials are present in the
 * environment. No hardcoded fallbacks — absence means unconfigured.
 */
export function isAcrCloudConfigured(): boolean {
  return Boolean(
    process.env.ACRCLOUD_HOST &&
    process.env.ACRCLOUD_ACCESS_KEY &&
    process.env.ACRCLOUD_ACCESS_SECRET,
  );
}

// ── Core fingerprint call ─────────────────────────────────────────────────────

/**
 * Fingerprint audio against ACRCloud's database.
 *
 * STUB: returns `{ matched: false }` without network I/O until the real
 * ACRCloud /v1/identify integration (HMAC-SHA1-signed multipart POST, see
 * file-level doc comment) is implemented. The interface is stable — the real
 * call is a drop-in replacement of this function body.
 *
 * When credentials are absent the call short-circuits immediately; callers
 * must check `isAcrCloudConfigured()` before relying on results for gating.
 */
export async function fingerprintAudio(_audio: Buffer): Promise<FingerprintMatch> {
  if (!isAcrCloudConfigured()) {
    return { matched: false };
  }

  // STUB — future: build HMAC-signed multipart form, POST to ACRCloud,
  // parse response.metadata.music[0] → FingerprintMatch.
  return { matched: false };
}

// ── Pre-publish screen ────────────────────────────────────────────────────────

/**
 * Pre-publish screen for artist uploads.
 *
 * Fingerprints the uploaded audio against ACRCloud. When no match is found
 * (or ACRCloud is unconfigured) the upload is allowed through. A match routes
 * to manual review rather than auto-blocking — the caller decides the next
 * step (e.g. queue for copyright team, notify uploader).
 *
 * Returns:
 *   `{ allow: true }` — no match; safe to publish.
 *   `{ allow: false, match }` — matched a known commercial recording; block
 *     and surface `match` to the review queue.
 */
export async function screenBeforePublish(
  audio: Buffer,
): Promise<{ allow: boolean; match?: FingerprintMatch }> {
  const match = await fingerprintAudio(audio);
  if (match.matched) {
    return { allow: false, match };
  }
  return { allow: true };
}
