import { uuidv7 } from '@oxy.so/db';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { accountActorChainSchema } from '@oxy.so/contracts';
import { setFileTaskAuthorityForTests } from '../services/oxyFiles/taskAuthority';

export function verifiedAudioSession(
  req: OxyAuthRequest,
  effectiveAccountId: string,
  actorAccountId = effectiveAccountId,
): void {
  req.user = { id: effectiveAccountId };
  req.accessToken = `verified-session:${actorAccountId}:${effectiveAccountId}`;
  req.oxyActor = accountActorChainSchema.parse({
    schemaVersion: 1,
    effectiveAccountId,
    actorAccountId,
    delegated: actorAccountId !== effectiveAccountId,
  });
}
export function installFileTaskAuthorityFixture(): void {
  setFileTaskAuthorityForTests({
    async createTask(input, options) {
      if (
        !options.requesterToken.startsWith('verified-session:') ||
        input.actor.type !== 'requester'
      )
        throw new Error('invalid original requester');
      return {
        id: uuidv7(),
        effectiveAccountId: input.effectiveAccountId,
        requesterAccountId: input.actor.accountId,
      };
    },
    async revokeTask() {},
  });
}
export function resetFileTaskAuthorityFixture(): void {
  setFileTaskAuthorityForTests(null);
}
