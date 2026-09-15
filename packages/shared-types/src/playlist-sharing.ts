import { z } from 'zod';

export const playlistInviteRequestSchema = z.object({ role: z.enum(['editor', 'viewer']) });
export const playlistInviteResponseSchema = z.object({ token: z.string(), expiresAt: z.string(), role: z.enum(['editor', 'viewer']) });
export const acceptPlaylistInviteSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
export const playlistJoinResponseSchema = z.object({ playlistId: z.string() });
export const playlistActivitySchema = z.object({
  id: z.string(), actorOxyUserId: z.string(),
  action: z.enum(['tracks_added', 'tracks_removed', 'tracks_reordered', 'member_joined', 'member_removed', 'role_changed', 'invites_revoked']),
  targetOxyUserId: z.string().nullable(), createdAt: z.string(),
});
export const playlistActivityResponseSchema = z.object({ items: z.array(playlistActivitySchema) });
