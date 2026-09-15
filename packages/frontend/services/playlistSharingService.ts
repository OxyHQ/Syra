import { api } from '@/utils/api';
import { playlistActivityResponseSchema, playlistInviteResponseSchema, playlistJoinResponseSchema } from '@syra/shared-types';

export const playlistSharingService = {
  async invite(id: string, role: 'editor' | 'viewer') {
    return playlistInviteResponseSchema.parse((await api.post(`/playlists/${encodeURIComponent(id)}/invites`, { role })).data);
  },
  async revoke(id: string) { await api.delete(`/playlists/${encodeURIComponent(id)}/invites`); },
  async join(token: string) {
    return playlistJoinResponseSchema.parse((await api.post('/playlists/join', { token })).data);
  },
  async changeMember(id: string, memberId: string, role: 'editor' | 'viewer' | null) {
    const path = `/playlists/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`;
    if (role === null) await api.delete(path);
    else await api.put(path, { role });
  },
  async activity(id: string) {
    return playlistActivityResponseSchema.parse((await api.get(`/playlists/${encodeURIComponent(id)}/activity`)).data);
  },
};
