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
