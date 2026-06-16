/**
 * Creative Commons license filter for commercial-use gating.
 *
 * Legal rationale: Syra re-hosts CC audio to its own S3 bucket and serves it
 * via CloudFront. This constitutes a commercial use of the content. Therefore
 * only CC licenses that explicitly permit commercial use may be imported:
 *   - CC0 / Public Domain Mark  (no rights reserved)
 *   - CC BY                     (attribution required)
 *   - CC BY-SA                  (attribution + share-alike required)
 *   - CC BY-ND                  (attribution + no-derivatives required)
 *
 * All NonCommercial variants (NC) are rejected:
 *   - CC BY-NC, CC BY-NC-SA, CC BY-NC-ND
 *
 * Unknown, empty, or non-CC licenses are also rejected — conservative default.
 */

/**
 * Normalise a raw license string into a canonical short-code for matching.
 *
 * Handles three common formats:
 *  - Short ids: 'by', 'by-sa', 'by-nc', 'cc0', 'publicdomain'
 *  - Full names: 'CC BY 4.0', 'Creative Commons Attribution-NonCommercial'
 *  - URLs: 'https://creativecommons.org/licenses/by-nc/4.0/'
 *
 * Returns the lowercase normalised string, or '' when the input is empty.
 */
export function normalizeLicenseId(license: string | undefined): string {
  if (!license) return '';

  const lower = license.toLowerCase().trim();

  // URL form — extract the meaningful path segments after /licenses/ or /publicdomain/
  if (lower.includes('creativecommons.org')) {
    // e.g. .../licenses/by-nc-sa/4.0/ → 'by-nc-sa'
    //      .../publicdomain/zero/1.0/  → 'zero'
    const licenseMatch = lower.match(/\/licenses\/([^/]+)/);
    if (licenseMatch) return licenseMatch[1];

    const pdMatch = lower.match(/\/publicdomain\/([^/]+)/);
    if (pdMatch) {
      const seg = pdMatch[1];
      // 'zero' (CC0) or 'mark' (public domain mark)
      if (seg === 'zero' || seg === 'mark') return 'cc0';
      return seg;
    }
  }

  // Full name / human-readable form — convert known names to short ids
  // 'creative commons attribution-noncommercial-sharealike' → 'by-nc-sa' etc.
  if (lower.includes('noncommercial') || lower.includes('non-commercial')) {
    // Determine the full NC variant
    const hasShare = lower.includes('sharealike') || lower.includes('share-alike');
    const hasNd = lower.includes('noderivative') || lower.includes('no-derivative') || lower.includes('noderivs') || lower.includes('no derivative');
    if (hasShare) return 'by-nc-sa';
    if (hasNd) return 'by-nc-nd';
    return 'by-nc';
  }

  // 'cc by 4.0', 'cc by-sa 3.0', etc. — strip 'cc ', version numbers, dots
  if (lower.startsWith('cc ') || lower === 'cc0') {
    // Remove 'cc ' prefix and version suffix (e.g. '4.0', '3.0 us')
    return lower
      .replace(/^cc\s+/, '')
      .replace(/\s+\d+\.\d+.*$/, '')
      .trim();
  }

  // 'creative commons attribution' (BY) → 'by', 'creative commons attribution-sharealike' → 'by-sa'
  if (lower.startsWith('creative commons')) {
    const hasShare = lower.includes('sharealike') || lower.includes('share-alike');
    const hasNd = lower.includes('noderivative') || lower.includes('no derivative') || lower.includes('noderivs');
    // Attribution present?
    if (lower.includes('attribution')) {
      if (hasShare) return 'by-sa';
      if (hasNd) return 'by-nd';
      return 'by';
    }
  }

  // Short id or unrecognised — return as-is (already lowercase)
  return lower;
}

/** License component tokens that indicate NonCommercial restriction. */
const NC_TOKENS = new Set(['nc', 'noncommercial', 'non-commercial']);

/**
 * Returns true only for CC licenses that permit commercial use.
 *
 * Licenses from external providers (Jamendo, ccMixter, archive.org, etc.)
 * arrive in varied formats. This function normalises the value and then
 * checks against a strict allow-list — anything not recognised is rejected.
 */
export function permitsCommercialUse(license: string | undefined): boolean {
  const id = normalizeLicenseId(license);
  if (!id) return false;

  // Split on '-' and ' ' to get individual license components for component-based matching
  const components = id.split(/[-\s]+/);

  // Reject if ANY component indicates NonCommercial
  if (components.some((c) => NC_TOKENS.has(c))) return false;

  // Allow-list: CC0 / public domain variants
  if (id === 'cc0' || id === 'zero' || id === 'publicdomain' || id === 'public domain') {
    return true;
  }

  // Allow-list: CC BY family (commercial-use-permitted)
  //  'by'      → CC BY
  //  'by-sa'   → CC BY-SA
  //  'by-nd'   → CC BY-ND
  const ALLOWED_CC = new Set(['by', 'by-sa', 'by-nd']);
  if (ALLOWED_CC.has(id)) return true;

  return false;
}
