import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DbTransaction } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { listeningEvents, userMusicPreferences } from '../../db/schema/user';
import { playlists, playlistTracks, playlistCollaborators, userLikedTracks } from '../../db/schema/library';
import { tasteMixes } from '../../db/schema/listener-tools';
import { playableTrackFilter } from '../../db/catalog/visibility';
import { ListenerAccessError } from './access-error';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HISTORY_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;
const MIX_TRACK_LIMIT = 30;

/** Deterministic overlap first, then alternating picks; neither person dominates. */
export function balanceTasteTracks(first: string[], second: string[], limit = MIX_TRACK_LIMIT): string[] {
  const secondSet = new Set(second);
  const selected = new Set(first.filter((id) => secondSet.has(id)).slice(0, Math.floor(limit / 3)));
  for (let index = 0; selected.size < limit && index < Math.max(first.length, second.length); index += 1) {
    if (first[index]) selected.add(first[index]);
    if (selected.size < limit && second[index]) selected.add(second[index]);
  }
  return [...selected].slice(0, limit);
}

export async function createTasteMix(userId: string, username: string) {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`taste-mix:${userId}`}, 0))`);
    await tx.delete(tasteMixes).where(and(eq(tasteMixes.hostOxyUserId, userId), isNull(tasteMixes.guestOxyUserId), lte(tasteMixes.expiresAt, new Date())));
    const pending = await tx.select({ id: tasteMixes.id }).from(tasteMixes)
      .where(and(eq(tasteMixes.hostOxyUserId, userId), isNull(tasteMixes.guestOxyUserId))).limit(5);
    if (pending.length >= 5) throw new ListenerAccessError(409, 'Revoke an existing mix invitation before creating another');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);
    const [mix] = await tx.insert(tasteMixes).values({ hostOxyUserId: userId, hostUsername: username, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt })
      .returning({ id: tasteMixes.id });
    if (!mix) throw new Error('Mix insert did not return an id');
    return { id: mix.id, token, expiresAt: expiresAt.toISOString() };
  });
}

async function tasteCandidates(tx: DbTransaction, userId: string, allowExplicit: boolean): Promise<string[]> {
  const recent = await tx.select({ id: listeningEvents.trackId, score: sql<number>`sum(${listeningEvents.completion})`.mapWith(Number) })
    .from(listeningEvents).innerJoin(tracks, eq(tracks.id, listeningEvents.trackId))
    .where(and(eq(listeningEvents.oxyUserId, userId), gte(listeningEvents.playedAt, new Date(Date.now() - HISTORY_WINDOW_MS)),
      gte(listeningEvents.completion, 0.3), eq(listeningEvents.skipped, false), playableTrackFilter(),
      allowExplicit ? undefined : eq(tracks.isExplicit, false)))
    .groupBy(listeningEvents.trackId).orderBy(desc(sql`sum(${listeningEvents.completion})`), listeningEvents.trackId).limit(100);
  const liked = await tx.select({ id: userLikedTracks.trackId }).from(userLikedTracks)
    .innerJoin(tracks, eq(tracks.id, userLikedTracks.trackId))
    .where(and(eq(userLikedTracks.oxyUserId, userId), playableTrackFilter(), allowExplicit ? undefined : eq(tracks.isExplicit, false)))
    .orderBy(desc(userLikedTracks.createdAt), userLikedTracks.trackId).limit(100);
  return [...new Set([...recent.map((row) => row.id), ...liked.map((row) => row.id)])].slice(0, 100);
}

/** No other-account taste read is reachable until BOTH people explicitly consent. */
export async function joinTasteMix(token: string, userId: string, username: string) {
  return getDb().transaction(async (tx) => {
    const [mix] = await tx.select({ id: tasteMixes.id, host: tasteMixes.hostOxyUserId, hostUsername: tasteMixes.hostUsername, guest: tasteMixes.guestOxyUserId, playlistId: tasteMixes.playlistId })
      .from(tasteMixes).where(and(eq(tasteMixes.tokenHash, createHash('sha256').update(token).digest('hex')), gt(tasteMixes.expiresAt, new Date())))
      .for('update');
    if (!mix) throw new ListenerAccessError(404, 'This mix invitation has expired or was revoked');
    if (mix.host === userId) throw new ListenerAccessError(400, 'Send this invitation to another person');
    if (mix.guest) {
      if (mix.guest !== userId || !mix.playlistId) throw new ListenerAccessError(409, 'This invitation has already been accepted');
      return { playlistId: mix.playlistId };
    }
    const preferences = await tx.select({ allowed: userMusicPreferences.explicitContent }).from(userMusicPreferences)
      .where(inArray(userMusicPreferences.oxyUserId, [mix.host, userId]));
    const allowExplicit = preferences.every((entry) => entry.allowed);
    const first = await tasteCandidates(tx, mix.host, allowExplicit);
    const second = await tasteCandidates(tx, userId, allowExplicit);
    if (!first.length || !second.length) throw new ListenerAccessError(409, 'Both people need to listen to or like some music before creating a mix');
    const ids = balanceTasteTracks(first, second);
    const durations = await tx.select({ duration: tracks.duration }).from(tracks).where(inArray(tracks.id, ids));
    const [playlist] = await tx.insert(playlists).values({ name: 'Taste match', description: 'A one-time mix created with both listeners’ consent.',
      ownerOxyUserId: mix.host, ownerUsername: mix.hostUsername, visibility: 'private', trackCount: ids.length,
      totalDuration: durations.reduce((sum, row) => sum + row.duration, 0),
    }).returning({ id: playlists.id });
    if (!playlist) throw new Error('Mix playlist insert did not return an id');
    await tx.insert(playlistTracks).values(ids.map((trackId, position) => ({ playlistId: playlist.id, trackId, position, addedAt: new Date(), addedBy: userId })));
    await tx.insert(playlistCollaborators).values({ playlistId: playlist.id, oxyUserId: userId, username, role: 'editor', addedAt: new Date() });
    await tx.update(tasteMixes).set({ guestOxyUserId: userId, playlistId: playlist.id }).where(eq(tasteMixes.id, mix.id));
    return { playlistId: playlist.id };
  });
}

export async function listTasteMixes(userId: string) {
  const rows = await getDb().select({ id: tasteMixes.id, playlistId: tasteMixes.playlistId, expiresAt: tasteMixes.expiresAt })
    .from(tasteMixes).where(or(eq(tasteMixes.hostOxyUserId, userId), eq(tasteMixes.guestOxyUserId, userId)))
    .orderBy(desc(tasteMixes.createdAt)).limit(50);
  return { items: rows.map((row) => ({ ...row, expiresAt: row.expiresAt.toISOString() })) };
}

/** Withdrawing either consent deletes the generated shared playlist and invitation. */
export async function revokeTasteMix(id: string, userId: string) {
  await getDb().transaction(async (tx) => {
    const [mix] = await tx.select({ id: tasteMixes.id, playlistId: tasteMixes.playlistId }).from(tasteMixes)
      .where(and(eq(tasteMixes.id, id), or(eq(tasteMixes.hostOxyUserId, userId), eq(tasteMixes.guestOxyUserId, userId))))
      .for('update');
    if (!mix) throw new ListenerAccessError(404, 'Mix not found');
    if (mix.playlistId) await tx.delete(playlists).where(eq(playlists.id, mix.playlistId));
    await tx.delete(tasteMixes).where(eq(tasteMixes.id, id));
  });
}
