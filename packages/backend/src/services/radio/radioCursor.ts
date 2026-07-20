import { radioSeedTypeSchema, RadioSeedType } from '@syra/shared-types';

/**
 * The opaque pagination token handed to radio clients.
 *
 * `v` is a format version so a future shape change can be rejected cleanly
 * instead of being misread as the current shape.
 */
export interface RadioCursor {
  v: 1;
  seedType: RadioSeedType;
  seedId: string;
  page: number;
}

/** Current cursor format. Bump only alongside a breaking shape change. */
export const RADIO_CURSOR_VERSION = 1;

/**
 * Encode a cursor as base64url(JSON).
 *
 * DELIBERATELY UNSIGNED — do not "harden" this by adding an HMAC.
 *
 * A signature would only be worth its cost if the cursor carried a claim the
 * server trusts. It does not: the cursor names a *station* (seed + page), never
 * an owner. The owner key is always re-derived server-side from the request
 * (the authenticated user, or the guest identifier), so a forged or replayed
 * cursor cannot read, resume, or poison another listener's station — the worst
 * a tampered cursor achieves is asking for a different public page of the same
 * public catalog, which is exactly what an unauthenticated caller could request
 * by hand anyway. Signing it would add key management and rotation risk to
 * protect nothing.
 */
export function encodeRadioCursor(cursor: RadioCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode a cursor produced by {@link encodeRadioCursor}.
 *
 * Returns `null` on any failure — malformed base64, unparseable JSON, an
 * unknown version, or a missing/ill-typed field — and never throws. Callers
 * treat `null` as "start a fresh station" rather than as an error, so a client
 * holding a stale cursor degrades into a new station instead of a 400.
 */
export function decodeRadioCursor(raw: string): RadioCursor | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== RADIO_CURSOR_VERSION) {
    return null;
  }

  const seedType = radioSeedTypeSchema.safeParse(candidate.seedType);
  if (!seedType.success) {
    return null;
  }

  if (typeof candidate.seedId !== 'string') {
    return null;
  }

  const page = candidate.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 0) {
    return null;
  }

  return {
    v: RADIO_CURSOR_VERSION,
    seedType: seedType.data,
    seedId: candidate.seedId,
    page,
  };
}
