/**
 * The signed-in user's id, off an Express request.
 *
 * It lived in `utils/catalogVisibility.ts` and had nothing to do with either
 * database — which is why `db/catalog/__tests__/halfPortedImports.test.ts` had
 * to carry it as a named exemption: a controller that had moved its queries to
 * drizzle but still called this one function looked half-ported and was not.
 *
 * Giving it a home of its own removed the exemption rather than re-homing it,
 * and it did not wait for `utils/catalogVisibility.ts` to die — which it since
 * has, in Task 11. An exemption that outlives the work it describes is the
 * shape the registries on this branch exist to prevent, so retiring it first
 * was the point.
 *
 * Distinct from `getRequiredOxyUserId` (`@oxyhq/core/server`), which THROWS on
 * an unauthenticated request. This one answers `undefined`, because its callers
 * are public endpoints whose behaviour merely varies with who is asking.
 */

import type { OxyAuthRequest } from '@oxyhq/core/server';

export function getRequestUserId(req: Pick<OxyAuthRequest, 'user'>): string | undefined {
  const id = req.user?.id || req.user?._id;
  return typeof id === 'string' && id.trim() ? id : undefined;
}
