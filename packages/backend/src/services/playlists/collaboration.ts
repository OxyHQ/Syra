import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, lte } from 'drizzle-orm';
import type { DbTransaction } from '../../db/postgres';
import { getDb } from '../../db/postgres';
import { playlists, playlistCollaborators } from '../../db/schema/library';
import { playlistActivity, playlistInvites } from '../../db/schema/playlist-sharing';

const MAX_MEMBERS = 50;
const MAX_ACTIVE_INVITES = 10;
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class PlaylistAccessError extends Error {
  constructor(public readonly status: number, message: string, public readonly details: Record<string, unknown> = {}) { super(message); }
}

/** All writers acquire this row lock before checking roles, including revocation. */
export async function lockPlaylistForEdit(tx: DbTransaction, playlistId: string, userId: string, ownerOnly = false) {
  const [playlist] = await tx.select().from(playlists).where(eq(playlists.id, playlistId)).for('update');
  if (!playlist) throw new PlaylistAccessError(404, 'Playlist not found');
  if (playlist.ownerOxyUserId === userId) return playlist;
  const [member] = await tx.select({ role: playlistCollaborators.role }).from(playlistCollaborators)
    .where(and(eq(playlistCollaborators.playlistId, playlistId), eq(playlistCollaborators.oxyUserId, userId)));
  if (ownerOnly || member?.role !== 'editor') throw new PlaylistAccessError(403, 'Forbidden');
  return playlist;
}

export async function createPlaylistInvite(playlistId: string, userId: string, role: 'editor' | 'viewer') {
  return getDb().transaction(async (tx) => {
    await lockPlaylistForEdit(tx, playlistId, userId, true);
    const now = new Date();
    await tx.delete(playlistInvites).where(and(eq(playlistInvites.playlistId, playlistId), lte(playlistInvites.expiresAt, now)));
    const [total] = await tx.select({ value: count() }).from(playlistInvites).where(eq(playlistInvites.playlistId, playlistId));
    if (total.value >= MAX_ACTIVE_INVITES) throw new PlaylistAccessError(409, 'Revoke existing invitations before creating more');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + INVITE_LIFETIME_MS);
    await tx.insert(playlistInvites).values({ playlistId, issuedBy: userId, role, expiresAt, tokenHash: createHash('sha256').update(token).digest('hex') });
    return { token, role, expiresAt: expiresAt.toISOString() };
  });
}

export async function joinPlaylist(token: string, userId: string, username: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return getDb().transaction(async (tx) => {
    const [candidate] = await tx.select({ playlistId: playlistInvites.playlistId }).from(playlistInvites)
      .where(eq(playlistInvites.tokenHash, tokenHash));
    if (!candidate) throw new PlaylistAccessError(404, 'Invitation unavailable');
    // Lock the playlist before re-reading the grant: revoke and join use the same order.
    const [playlist] = await tx.select().from(playlists).where(eq(playlists.id, candidate.playlistId)).for('update');
    const [invite] = await tx.select({ issuedBy: playlistInvites.issuedBy, role: playlistInvites.role }).from(playlistInvites).where(and(eq(playlistInvites.tokenHash, tokenHash), gt(playlistInvites.expiresAt, new Date())));
    if (!playlist || !invite || invite.issuedBy !== playlist.ownerOxyUserId) throw new PlaylistAccessError(404, 'Invitation unavailable');
    if (playlist.ownerOxyUserId !== userId) {
      const [existing] = await tx.select().from(playlistCollaborators).where(and(eq(playlistCollaborators.playlistId, playlist.id), eq(playlistCollaborators.oxyUserId, userId)));
      if (!existing) {
        const [total] = await tx.select({ value: count() }).from(playlistCollaborators).where(eq(playlistCollaborators.playlistId, playlist.id));
        if (total.value >= MAX_MEMBERS) throw new PlaylistAccessError(409, 'Playlist member limit reached');
        await tx.insert(playlistCollaborators).values({ playlistId: playlist.id, oxyUserId: userId, username, role: invite.role, addedAt: new Date() });
        await tx.insert(playlistActivity).values({ playlistId: playlist.id, actorOxyUserId: userId, action: 'member_joined' });
      }
      // Accepting another link never upgrades an existing member's permissions.
    }
    return { playlistId: playlist.id };
  });
}

export async function revokePlaylistInvites(playlistId: string, userId: string) {
  await getDb().transaction(async (tx) => {
    await lockPlaylistForEdit(tx, playlistId, userId, true);
    await tx.delete(playlistInvites).where(eq(playlistInvites.playlistId, playlistId));
    await tx.insert(playlistActivity).values({ playlistId, actorOxyUserId: userId, action: 'invites_revoked' });
  });
}

export async function changePlaylistMember(playlistId: string, userId: string, targetId: string, role: 'editor' | 'viewer' | null) {
  await getDb().transaction(async (tx) => {
    const playlist = await lockPlaylistForEdit(tx, playlistId, userId, true);
    if (targetId === playlist.ownerOxyUserId) throw new PlaylistAccessError(400, 'The owner cannot be changed here');
    const predicate = and(eq(playlistCollaborators.playlistId, playlistId), eq(playlistCollaborators.oxyUserId, targetId));
    const changed = role === null
      ? await tx.delete(playlistCollaborators).where(predicate).returning({ id: playlistCollaborators.id })
      : await tx.update(playlistCollaborators).set({ role }).where(predicate).returning({ id: playlistCollaborators.id });
    if (changed.length === 0) throw new PlaylistAccessError(404, 'Member not found');
    // A removed member must not rejoin with a still-active shared invitation.
    if (role === null) await tx.delete(playlistInvites).where(eq(playlistInvites.playlistId, playlistId));
    await tx.insert(playlistActivity).values({ playlistId, actorOxyUserId: userId, targetOxyUserId: targetId, action: role === null ? 'member_removed' : 'role_changed' });
  });
}

export async function readPlaylistActivity(playlistId: string, userId: string) {
  const [playlist] = await getDb().select().from(playlists).where(eq(playlists.id, playlistId));
  const [member] = await getDb().select({ id: playlistCollaborators.id }).from(playlistCollaborators)
    .where(and(eq(playlistCollaborators.playlistId, playlistId), eq(playlistCollaborators.oxyUserId, userId)));
  if (!playlist || (playlist.ownerOxyUserId !== userId && !member)) throw new PlaylistAccessError(403, 'Forbidden');
  const rows = await getDb().select({ id: playlistActivity.id, actorOxyUserId: playlistActivity.actorOxyUserId, action: playlistActivity.action, targetOxyUserId: playlistActivity.targetOxyUserId, createdAt: playlistActivity.createdAt })
    .from(playlistActivity).where(eq(playlistActivity.playlistId, playlistId)).orderBy(desc(playlistActivity.createdAt), desc(playlistActivity.id)).limit(50);
  return { items: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })) };
}
