import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { acceptPlaylistInviteSchema, playlistInviteRequestSchema } from '@syra/shared-types';
import { z } from 'zod';
import { createPlaylistInvite, joinPlaylist, changePlaylistMember, revokePlaylistInvites, readPlaylistActivity, PlaylistAccessError } from '../services/playlists/collaboration';

const idSchema = z.string().min(1).max(128);
export async function playlistSharing(req: OxyAuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method === 'POST' && req.path === '/join') {
      const { token } = acceptPlaylistInviteSchema.parse(req.body);
      return res.json(await joinPlaylist(token, userId, req.user?.username ?? userId));
    }
    const id = idSchema.parse(req.params.id);
    if (req.path.endsWith('/activity')) return res.json(await readPlaylistActivity(id, userId));
    if (req.path.endsWith('/invites')) {
      if (req.method === 'POST') {
        const { role } = playlistInviteRequestSchema.parse(req.body);
        return res.status(201).json(await createPlaylistInvite(id, userId, role));
      }
      await revokePlaylistInvites(id, userId);
    } else {
      const memberId = idSchema.parse(req.params.memberId);
      const role = req.method === 'DELETE' ? null : playlistInviteRequestSchema.parse(req.body).role;
      await changePlaylistMember(id, userId, memberId, role);
    }
    return res.status(204).send();
  } catch (error) {
    if (error instanceof PlaylistAccessError) return res.status(error.status).json({ error: error.message });
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid playlist sharing request' });
    return next(error);
  }
}
