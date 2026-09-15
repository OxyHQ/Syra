import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { userFollowedArtists } from '../../db/schema/library';
import { notificationPreferences } from '../../db/schema/user';
import { playableTrackFilter } from '../../db/catalog/visibility';
import { isEventDisabled } from '../../db/user/notifications';
import { notifyUser, type NotifierDeps } from '../notifications/notifier';

const RELEASE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export async function readReleasePreference(userId: string) {
  return { enabled: !(await isEventDisabled(userId, 'artist.release')) };
}

/** One atomic array update preserves preferences for every other event. */
export async function setReleasePreference(userId: string, enabled: boolean) {
  await getDb().insert(notificationPreferences).values({ oxyUserId: userId, disabledEvents: enabled ? [] : ['artist.release'] })
    .onConflictDoUpdate({ target: notificationPreferences.oxyUserId, set: {
      disabledEvents: enabled
        ? sql`array_remove(${notificationPreferences.disabledEvents}, 'artist.release')`
        : sql`array_append(array_remove(${notificationPreferences.disabledEvents}, 'artist.release'), 'artist.release')`,
      updatedAt: new Date(),
    } });
  return { enabled };
}

/** Back catalogue and hidden music are never announced. Delivery shares Oxy's notifier. */
export async function notifyFollowersOfNewRelease(trackId: string, now = Date.now(), deps?: NotifierDeps) {
  const [track] = await getDb().select({ id: tracks.id, artistId: tracks.artistId, artistName: tracks.artistName,
    title: tracks.title, releaseDate: tracks.releaseDate, createdAt: tracks.createdAt })
    .from(tracks).where(and(eq(tracks.id, trackId), playableTrackFilter(), eq(tracks.status, 'ready'))).limit(1);
  // Missing/partial original dates cannot be presented as a new release. A recent
  // upload of an old recording is not a new release either.
  if (!track?.releaseDate || now - track.releaseDate.getTime() > RELEASE_MAX_AGE_MS ||
    track.releaseDate.getTime() > now || now - track.createdAt.getTime() > RELEASE_MAX_AGE_MS) return { emitted: 0 };
  let cursor: string | undefined;
  let emitted = 0;
  while (true) {
    const followers = await getDb().select({ id: userFollowedArtists.oxyUserId }).from(userFollowedArtists)
      .where(and(eq(userFollowedArtists.artistId, track.artistId), lte(userFollowedArtists.createdAt, track.createdAt),
        cursor ? gt(userFollowedArtists.oxyUserId, cursor) : undefined))
      .orderBy(asc(userFollowedArtists.oxyUserId)).limit(100);
    if (!followers.length) break;
    // Bounded network fan-out; no unbounded array of promises for a large artist.
    for (let index = 0; index < followers.length; index += 4) {
      const results = await Promise.all(followers.slice(index, index + 4).map(({ id }) => notifyUser({
        recipientId: id, actorId: track.artistId, event: 'artist.release', entityId: track.id, entityType: 'track',
        title: track.artistName, message: track.title, coalesceGroupId: track.artistId,
        data: { artistId: track.artistId, trackId: track.id },
      }, deps)));
      emitted += results.filter((result) => result.emitted).length;
    }
    cursor = followers[followers.length - 1].id;
  }
  return { emitted };
}
