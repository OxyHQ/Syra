import type { OxyAuthRequest } from '@oxy.so/core/server';
import { accountActorChainSchema } from '@oxy.so/contracts';

/** What the shared auth middleware leaves on a verified session's request. */
export function signedIn(
  req: OxyAuthRequest,
  effectiveAccountId: string,
  actorAccountId = effectiveAccountId,
): void {
  req.user = { id: effectiveAccountId };
  req.oxyActor = accountActorChainSchema.parse({
    schemaVersion: 1,
    effectiveAccountId,
    actorAccountId,
    delegated: actorAccountId !== effectiveAccountId,
  });
}
