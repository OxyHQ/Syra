import { type ActingFor, getOxyActor, type OxyAuthRequest } from '@oxy.so/core/server';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { userUploads } from '../../db/schema/creators';

/**
 * Whose Oxy Files Syra writes, and for whom (oxy ADR 0066).
 *
 * Syra's entry in oxy's first-party registry declares `oxy:files` write, so it
 * names the account and nothing else: no session, task or ticket, nothing to
 * renew, the same in the foreground and in a background copy. Oxy checks the
 * accounts live on every call.
 */

/**
 * The signed-in account, and the person operating it when it is not theirs (an
 * organization). Read from the session the shared middleware verified, never
 * from a header.
 */
export function requestActingFor(req: OxyAuthRequest): ActingFor {
  const accountId = req.user?.id;
  if (!accountId) throw new Error('A personal Files operation needs a signed-in account');
  const operator = operatorOf(req);
  return operator ? { accountId, requesterAccountId: operator } : { accountId };
}

/** The person operating the signed-in account, or `null` when they own it. */
export function operatorOf(req: OxyAuthRequest): string | null {
  const actor = getOxyActor(req);
  return actor && actor.actorAccountId !== actor.effectiveAccountId ? actor.actorAccountId : null;
}

/** An owner's Files, with the person who operated it when the row was made. */
export function ownerActingFor(
  ownerOxyUserId: string,
  operatorOxyUserId: string | null,
): ActingFor {
  return operatorOxyUserId
    ? { accountId: ownerOxyUserId, requesterAccountId: operatorOxyUserId }
    : { accountId: ownerOxyUserId };
}

/**
 * An owner re-uploading a locker file Oxy does not hold yet resumes its copy;
 * the row keeps its id and records who asked this time. `false` when the row is
 * not theirs or its audio is already stored.
 */
export async function resumeLockerCopy(req: OxyAuthRequest, uploadId: string): Promise<boolean> {
  const accountId = req.user?.id;
  if (!accountId) return false;
  const resumed = await getDb()
    .update(userUploads)
    .set({ operatorOxyUserId: operatorOf(req) })
    .where(
      and(
        eq(userUploads.id, uploadId),
        eq(userUploads.ownerOxyUserId, accountId),
        isNull(userUploads.audioFileId),
      ),
    )
    .returning({ id: userUploads.id });
  return resumed.length > 0;
}
