import type { OxyAuthRequest, RequesterProof, ServerAgencyApi } from '@oxy.so/core/server';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { oxy } from '../../oxyClient';
import { getDb } from '../../db/postgres';
import { episodes, podcasts } from '../../db/schema/podcasts';
import { userUploads } from '../../db/schema/creators';
import { oxyFileTaskRevocations } from '../../db/schema/oxyFiles';

const AUTHORITY_LIFETIME_MS = 24 * 60 * 60_000;
type Authority = {
  createTask(
    ...args: Parameters<ServerAgencyApi['createTask']>
  ): Promise<
    Pick<
      Awaited<ReturnType<ServerAgencyApi['createTask']>>,
      'id' | 'requesterAccountId' | 'effectiveAccountId'
    >
  >;
  revokeTask: ServerAgencyApi['revokeTask'];
};
let override: Authority | null = null;
export function setFileTaskAuthorityForTests(authority: Authority | null): void {
  override = authority;
}
const authority = () => override ?? oxy.agency;

/** Created only while the original verified session is present. No bearer is persisted. */
export async function createFileTask(req: OxyAuthRequest, entityId: string): Promise<string> {
  const effectiveAccountId = req.user?.id;
  const actorAccountId = req.oxyActor?.actorAccountId;
  if (
    !req.accessToken ||
    !effectiveAccountId ||
    !actorAccountId ||
    req.oxyActor?.effectiveAccountId !== effectiveAccountId
  ) {
    throw new Error('Audio admission requires the original verified requester and account');
  }
  const task = await authority().createTask(
    {
      origin: { kind: 'goal', id: `syra-audio:${entityId}` },
      actor: { type: 'requester', accountId: actorAccountId },
      effectiveAccountId,
      expiresAt: new Date(Date.now() + AUTHORITY_LIFETIME_MS).toISOString(),
    },
    { requesterToken: req.accessToken },
  );
  if (
    task.effectiveAccountId !== effectiveAccountId ||
    task.requesterAccountId !== actorAccountId
  ) {
    await queueFileTaskRevocation(task.id);
    throw new Error('Oxy returned a different audio requester or effective account');
  }
  return task.id;
}

/** A failed/duplicate domain insert keeps central revocation durable. */
export async function withFileTask<T>(
  req: OxyAuthRequest,
  entityId: string,
  write: (taskId: string) => Promise<T>,
): Promise<T> {
  const taskId = await createFileTask(req, entityId);
  try {
    return await write(taskId);
  } catch (error) {
    await queueFileTaskRevocation(taskId);
    throw error;
  }
}

/** Domain deletes/replacements also queue this through database triggers. */
export async function queueFileTaskRevocation(taskId: string): Promise<void> {
  await getDb().insert(oxyFileTaskRevocations).values({ taskId }).onConflictDoNothing();
}

/** Only the task already admitted for this exact row/account can authorize a copy. */
export async function personalAudioRequester(
  kind: 'episode' | 'user_upload',
  id: string,
  accountId: string,
): Promise<RequesterProof | null> {
  let taskId: string | null | undefined;
  if (kind === 'user_upload') {
    const [row] = await getDb()
      .select({ taskId: userUploads.oxyTaskId })
      .from(userUploads)
      .where(and(eq(userUploads.id, id), eq(userUploads.ownerOxyUserId, accountId)))
      .limit(1);
    taskId = row?.taskId;
  } else {
    const [row] = await getDb()
      .select({ taskId: episodes.oxyTaskId })
      .from(episodes)
      .innerJoin(podcasts, eq(podcasts.id, episodes.podcastId))
      .where(and(eq(episodes.id, id), eq(podcasts.ownerOxyUserId, accountId)))
      .limit(1);
    taskId = row?.taskId;
  }
  if (!taskId) return null;
  const [revoked] = await getDb()
    .select({ taskId: oxyFileTaskRevocations.taskId })
    .from(oxyFileTaskRevocations)
    .where(eq(oxyFileTaskRevocations.taskId, taskId))
    .limit(1);
  return revoked ? null : { taskId, accountId };
}

/** Revoke before forgetting an ID. Duplicate delivery is safe across API processes. */
export async function drainFileTaskRevocations(): Promise<void> {
  const rows = await getDb()
    .select({ taskId: oxyFileTaskRevocations.taskId })
    .from(oxyFileTaskRevocations)
    .where(lte(oxyFileTaskRevocations.nextAttemptAt, new Date()))
    .limit(25);
  for (const row of rows) {
    try {
      await authority().revokeTask(row.taskId);
      await getDb()
        .delete(oxyFileTaskRevocations)
        .where(eq(oxyFileTaskRevocations.taskId, row.taskId));
    } catch {
      await getDb()
        .update(oxyFileTaskRevocations)
        .set({
          attempts: sql`${oxyFileTaskRevocations.attempts} + 1`,
          nextAttemptAt: new Date(Date.now() + 60_000),
        })
        .where(eq(oxyFileTaskRevocations.taskId, row.taskId));
    }
  }
}

class AudioAdmissionRace extends Error {}
/** An ordinary owner re-upload may resume an uncopied locker item, retaining its ID. */
export async function refreshLockerFileTask(
  req: OxyAuthRequest,
  uploadId: string,
): Promise<boolean> {
  const accountId = req.user?.id;
  if (!accountId) return false;
  const [row] = await getDb()
    .select({ taskId: userUploads.oxyTaskId })
    .from(userUploads)
    .where(
      and(
        eq(userUploads.id, uploadId),
        eq(userUploads.ownerOxyUserId, accountId),
        isNull(userUploads.audioFileId),
      ),
    )
    .limit(1);
  if (!row) return false;
  try {
    return await withFileTask(req, uploadId, async (oxyTaskId) => {
      const changed = await getDb()
        .update(userUploads)
        .set({ oxyTaskId })
        .where(
          and(
            eq(userUploads.id, uploadId),
            eq(userUploads.ownerOxyUserId, accountId),
            isNull(userUploads.audioFileId),
            row.taskId ? eq(userUploads.oxyTaskId, row.taskId) : isNull(userUploads.oxyTaskId),
          ),
        )
        .returning({ id: userUploads.id });
      if (!changed.length) throw new AudioAdmissionRace();
      return true;
    });
  } catch (error) {
    if (error instanceof AudioAdmissionRace) return false;
    throw error;
  }
}
