import { getRedisClient } from './redis';
import { ensureRedisConnected } from './redisHelpers';
import { logger } from './logger';

/**
 * Best-effort distributed lock backed by Redis `SET NX PX`. Used so that a
 * periodic background job runs on exactly one instance at a time across a
 * horizontally-scaled fleet (the deployment runs multiple ECS tasks behind the
 * ALB). The lock auto-expires via `PX` so a crashed holder never wedges the job
 * permanently.
 *
 * When Redis is unavailable the lock is considered NOT acquired, so the job
 * simply skips that tick rather than risking concurrent runs — safe degradation
 * for a non-critical maintenance task.
 */
export async function withLock(
  key: string,
  ttlMs: number,
  task: () => Promise<void>,
): Promise<boolean> {
  const lockKey = `lock:${key}`;
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  let client;
  try {
    client = getRedisClient();
  } catch {
    return false;
  }

  const ready = await ensureRedisConnected(client).catch(() => false);
  if (!ready) return false;

  let acquired = false;
  try {
    const result = await client.set(lockKey, token, { NX: true, PX: ttlMs });
    acquired = result === 'OK';
  } catch (err) {
    logger.debug('[lock] failed to acquire', { key, err });
    return false;
  }

  if (!acquired) return false;

  try {
    await task();
    return true;
  } finally {
    // Release only if we still own the lock (compare-and-delete) to avoid
    // deleting a lock another instance acquired after ours expired.
    try {
      const current = await client.get(lockKey);
      if (current === token) {
        await client.del(lockKey);
      }
    } catch (err) {
      logger.debug('[lock] failed to release', { key, err });
    }
  }
}
