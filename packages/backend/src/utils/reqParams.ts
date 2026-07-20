import type { Request } from 'express';

/**
 * Express types req.params values as string | string[]; for our single-segment
 * routes they are always strings. This helper normalises the value so callers
 * can use it where a string is expected without unsafe casts.
 */
export function getParam(req: Request, name: string): string {
  const v = req.params[name];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

/**
 * Ceiling for catalog list endpoints that do not need a tighter bound of their
 * own. 100 is comfortably above anything a client asks for (the largest page
 * the apps request is 50) while keeping a single request's cost bounded: every
 * item in a catalog page costs a serialization plus an image-URL resolution, so
 * an uncapped `?limit=` on these unauthenticated routes is a free way to make
 * the API do arbitrary work.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Parse a pagination `limit` where UNUSABLE INPUT MEANS DEFAULT.
 *
 * Anything that is not a positive integer falls back to `fallback`, which keeps
 * the behaviour of the `parseInt(req.query.limit as string) || N` expressions
 * this replaced — the only change is the ceiling.
 *
 * Use this for endpoints that document a default rather than a range. If the
 * endpoint documents a closed range (`limit` clamped to 1–50), it wants
 * `parseClampedLimit` instead — `?limit=0` must become 1 there, not the default.
 */
export function parseBoundedLimit(
  value: unknown,
  fallback: number,
  max: number = MAX_PAGE_SIZE,
): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

/**
 * Parse a pagination `limit` where OUT-OF-RANGE INPUT CLAMPS TO THE NEAREST
 * VALID VALUE — the contract published by endpoints documented as "clamped to
 * min–max": `?limit=0` yields `min`, `?limit=999` yields `max`. Only input that
 * is not a number at all falls back to `fallback`.
 *
 * Deliberately a separate function from `parseBoundedLimit` rather than a flag
 * on it: the two are different published contracts that happen to share a shape,
 * and a caller reading `parseBoundedLimit(q, 20, 50, 1)` cannot see that the last
 * argument silently changes what `?limit=0` returns.
 */
export function parseClampedLimit(
  value: unknown,
  range: { min: number; max: number; fallback: number },
): number {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return range.fallback;
  }
  return Math.min(Math.max(parsed, range.min), range.max);
}

/**
 * Parse a zero-based pagination `offset`, clamped to `>= 0` (a negative value
 * makes MongoDB's `.skip()` throw). Deliberately has no upper bound: unlike
 * `limit`, a deep offset costs at most a walk of the collection and capping it
 * would silently serve the wrong page to a legitimate deep-paging client.
 */
export function parseOffset(value: unknown): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
