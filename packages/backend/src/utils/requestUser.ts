/**
 * The signed-in user's id, off an Express request.
 *
 * It has nothing to do with the database, so it lives on its own rather than
 * beside the catalog queries.
 *
 * Distinct from `getRequiredOxyUserId` (`@oxy.so/core/server`), which THROWS on
 * an unauthenticated request. This one answers `undefined`, because its callers
 * are public endpoints whose behaviour merely varies with who is asking.
 */

import type { OxyAuthRequest } from '@oxy.so/core/server';

export function getRequestUserId(req: Pick<OxyAuthRequest, 'user'>): string | undefined {
  const id = req.user?.id || req.user?._id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
