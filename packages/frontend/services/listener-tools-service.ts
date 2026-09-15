import {
  artistSchema, curatedPlaylistsResponseSchema, createdListenerPlaylistSchema,
  playlistImportPreviewSchema, mixInviteSchema, mixListSchema, releasePreferenceSchema,
  downloadPolicySchema, downloadGrantSchema, type PlaylistImportEntry,
} from '@syra/shared-types';
import { api, publicApi } from '@/utils/api';
import { normalizePlaylistImages, normalizeTrackImages } from '@/utils/catalogImages';

const privateRead = { cache: false };
export const listenerTools = {
  async curated(artistId: string) {
    const { data } = await publicApi.get<unknown>(`/listener/artists/${encodeURIComponent(artistId)}/playlists`);
    return curatedPlaylistsResponseSchema.parse(data).items.map(normalizePlaylistImages);
  },
  async ownedArtist() {
    const { data } = await api.get<unknown>('/artists/me', undefined, privateRead);
    return artistSchema.nullable().parse(data);
  },
  async saveCurated(artistId: string, playlistIds: string[]) {
    const { data } = await api.put<unknown>(`/listener/artists/${encodeURIComponent(artistId)}/playlists`, { playlistIds });
    return curatedPlaylistsResponseSchema.parse(data).items.map(normalizePlaylistImages);
  },
  async previewImport(entries: PlaylistImportEntry[]) {
    const { data } = await api.post<unknown>('/listener/import/preview', { entries }, { timeout: 30_000 });
    const parsed = playlistImportPreviewSchema.parse(data);
    return { items: parsed.items.map((item) => ({ ...item, track: item.track ? normalizeTrackImages(item.track) : null })) };
  },
  async commitImport(name: string, trackIds: string[], requestId: string) {
    const { data } = await api.post<unknown>('/listener/import', { name, trackIds, requestId }, { timeout: 30_000 });
    return createdListenerPlaylistSchema.parse(data);
  },
  async mixes() {
    return mixListSchema.parse((await api.get<unknown>('/listener/mixes', undefined, privateRead)).data).items;
  },
  async createMix() {
    return mixInviteSchema.parse((await api.post<unknown>('/listener/mixes', { consent: true })).data);
  },
  async joinMix(token: string) {
    return createdListenerPlaylistSchema.parse((await api.post<unknown>('/listener/mixes/join', { token, consent: true }, { timeout: 30_000 })).data);
  },
  async revokeMix(id: string) {
    await api.delete(`/listener/mixes/${encodeURIComponent(id)}`);
  },
  async releasePreference() {
    return releasePreferenceSchema.parse((await api.get<unknown>('/listener/releases', undefined, privateRead)).data);
  },
  async setReleasePreference(enabled: boolean) {
    return releasePreferenceSchema.parse((await api.put<unknown>('/listener/releases', { enabled })).data);
  },
  async downloadPolicy(id: string) {
    return downloadPolicySchema.parse((await api.get<unknown>(`/listener/tracks/${encodeURIComponent(id)}/download`, undefined, privateRead)).data);
  },
  async setDownloadPolicy(id: string, allowed: boolean) {
    return downloadPolicySchema.parse((await api.put<unknown>(`/listener/tracks/${encodeURIComponent(id)}/download`, { allowed })).data);
  },
  async grantDownload(id: string) {
    const data = downloadGrantSchema.parse((await api.post<unknown>(`/listener/tracks/${encodeURIComponent(id)}/download`)).data);
    return { ...data, track: normalizeTrackImages(data.track) };
  },
};
