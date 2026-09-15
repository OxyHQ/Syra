import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useOxy } from '@oxy.so/services';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Playlist } from '@syra/shared-types';
import { playlistSharingService } from '@/services/playlistSharingService';
import { shareUrl } from '@/utils/share-media';

export function PlaylistCollaboration({ playlist }: { playlist: Playlist }) {
  const { user, canUsePrivateApi } = useOxy();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const isOwner = user?.id === playlist.ownerOxyUserId;
  const canView = isOwner || playlist.collaborators?.some((member) => member.oxyUserId === user?.id);
  const activity = useQuery({
    queryKey: ['playlist', playlist.id, 'activity', user?.id],
    queryFn: () => playlistSharingService.activity(playlist.id),
    enabled: expanded && canUsePrivateApi && !!canView,
    refetchInterval: expanded ? 30_000 : false,
  });
  const change = useMutation({
    mutationFn: async (request: { action: 'invite'; role: 'editor' | 'viewer' } | { action: 'revoke' } | { action: 'member'; id: string; role: 'editor' | 'viewer' | null }) => {
      if (!canUsePrivateApi || !isOwner) throw new Error(t('collaboration.signIn'));
      if (request.action === 'invite') {
        const invite = await playlistSharingService.invite(playlist.id, request.role);
        const url = new URL('/join-playlist', process.env.EXPO_PUBLIC_APP_URL ?? 'https://syra.fm');
        url.searchParams.set('token', invite.token);
        await shareUrl(playlist.name, url.toString());
      } else if (request.action === 'revoke') await playlistSharingService.revoke(playlist.id);
      else await playlistSharingService.changeMember(playlist.id, request.id, request.role);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['playlist', playlist.id] });
      await queryClient.invalidateQueries({ queryKey: ['library'] });
    },
  });
  if (!canUsePrivateApi || !canView) return null;
  return <View className="px-6 py-4 gap-3">
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
      <Text className="text-foreground text-lg font-semibold">{t('collaboration.title')}</Text>
    </Pressable>
    {expanded ? <View className="gap-4">
      {isOwner ? <>
        <Text className="text-muted-foreground">{t('collaboration.inviteHint')}</Text>
        <View className="flex-row flex-wrap gap-4">
          {(['editor', 'viewer'] as const).map((role) => <Pressable key={role} accessibilityRole="button" disabled={change.isPending} onPress={() => change.mutate({ action: 'invite', role })}><Text className="text-primary">{t(`collaboration.invite_${role}`)}</Text></Pressable>)}
          <Pressable accessibilityRole="button" disabled={change.isPending} onPress={() => change.mutate({ action: 'revoke' })}><Text className="text-primary">{t('collaboration.revoke')}</Text></Pressable>
        </View>
      </> : null}
      {(playlist.collaborators ?? []).map((member) => <View key={member.oxyUserId} className="gap-2">
        <Text selectable className="text-foreground">{member.username} · {t(`collaboration.${member.role}`)}</Text>
        {isOwner && member.oxyUserId !== playlist.ownerOxyUserId ? <View className="flex-row gap-4">
          <Pressable accessibilityRole="button" disabled={change.isPending} onPress={() => change.mutate({ action: 'member', id: member.oxyUserId, role: member.role === 'editor' ? 'viewer' : 'editor' })}><Text className="text-primary">{t(member.role === 'editor' ? 'collaboration.makeViewer' : 'collaboration.makeEditor')}</Text></Pressable>
          <Pressable accessibilityRole="button" disabled={change.isPending} onPress={() => change.mutate({ action: 'member', id: member.oxyUserId, role: null })}><Text className="text-error">{t('collaboration.remove')}</Text></Pressable>
        </View> : null}
      </View>)}
      {change.isError ? <Text selectable accessibilityRole="alert" className="text-error">{change.error.message}</Text> : null}
      <Text className="text-foreground font-semibold">{t('collaboration.activity')}</Text>
      {activity.isLoading ? <Text className="text-muted-foreground">{t('state.loading')}</Text> : null}
      {activity.isError ? <Pressable accessibilityRole="button" onPress={() => void activity.refetch()}><Text className="text-error">{t('listener.retry')}</Text></Pressable> : null}
      {activity.data?.items.map((event) => <View key={event.id} className="gap-1">
        <Text className="text-foreground">{t(`collaboration.${event.action}`)}</Text>
        <Text selectable className="text-muted-foreground">{event.actorOxyUserId === playlist.ownerOxyUserId ? playlist.ownerUsername : playlist.collaborators?.find((member) => member.oxyUserId === event.actorOxyUserId)?.username ?? event.actorOxyUserId} · {new Date(event.createdAt).toLocaleString(i18n.language)}</Text>
      </View>)}
      {activity.data?.items.length === 0 ? <Text className="text-muted-foreground">{t('collaboration.noActivity')}</Text> : null}
    </View> : null}
  </View>;
}
