import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useOxy } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Playlist } from '@syra/shared-types';
import { playlistSharingService } from '@/services/playlistSharingService';
import { shareUrl } from '@/utils/share-media';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export function PlaylistCollaboration({ playlist }: { playlist: Playlist }) {
  const styles = useStyles();
  const { user, canUsePrivateApi } = useOxy();
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const isOwner = user?.id === playlist.ownerOxyUserId;
  const canView =
    isOwner || playlist.collaborators?.some((member) => member.oxyUserId === user?.id);
  const activity = useQuery({
    queryKey: ['playlist', playlist.id, 'activity', user?.id],
    queryFn: () => playlistSharingService.activity(playlist.id),
    enabled: expanded && canUsePrivateApi && !!canView,
    refetchInterval: expanded ? 30_000 : false,
  });
  const change = useMutation({
    mutationFn: async (
      request:
        | { action: 'invite'; role: 'editor' | 'viewer' }
        | { action: 'revoke' }
        | { action: 'member'; id: string; role: 'editor' | 'viewer' | null },
    ) => {
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
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={styles.title}>{t('collaboration.title')}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.stack}>
          {isOwner ? (
            <>
              <Text style={styles.mutedText}>{t('collaboration.inviteHint')}</Text>
              <View style={styles.row}>
                {(['editor', 'viewer'] as const).map((role) => (
                  <Pressable
                    key={role}
                    accessibilityRole="button"
                    disabled={change.isPending}
                    onPress={() => change.mutate({ action: 'invite', role })}
                  >
                    <Text style={styles.text}>{t(`collaboration.invite_${role}`)}</Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="button"
                  disabled={change.isPending}
                  onPress={() => change.mutate({ action: 'revoke' })}
                >
                  <Text style={styles.text}>{t('collaboration.revoke')}</Text>
                </Pressable>
              </View>
            </>
          ) : null}
          {(playlist.collaborators ?? []).map((member) => (
            <View key={member.oxyUserId} style={styles.stack2}>
              <Text selectable style={styles.text2}>
                {member.username} · {t(`collaboration.${member.role}`)}
              </Text>
              {isOwner && member.oxyUserId !== playlist.ownerOxyUserId ? (
                <View style={styles.row2}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={change.isPending}
                    onPress={() =>
                      change.mutate({
                        action: 'member',
                        id: member.oxyUserId,
                        role: member.role === 'editor' ? 'viewer' : 'editor',
                      })
                    }
                  >
                    <Text style={styles.text}>
                      {t(
                        member.role === 'editor'
                          ? 'collaboration.makeViewer'
                          : 'collaboration.makeEditor',
                      )}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={change.isPending}
                    onPress={() =>
                      change.mutate({ action: 'member', id: member.oxyUserId, role: null })
                    }
                  >
                    <Text style={styles.text3}>{t('collaboration.remove')}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))}
          {change.isError ? (
            <Text selectable accessibilityRole="alert" style={styles.text3}>
              {change.error.message}
            </Text>
          ) : null}
          <Text style={styles.title2}>{t('collaboration.activity')}</Text>
          {activity.isLoading ? <Text style={styles.mutedText}>{t('state.loading')}</Text> : null}
          {activity.isError ? (
            <Pressable accessibilityRole="button" onPress={() => void activity.refetch()}>
              <Text style={styles.text3}>{t('listener.retry')}</Text>
            </Pressable>
          ) : null}
          {activity.data?.items.map((event) => (
            <View key={event.id} style={styles.stack3}>
              <Text style={styles.text2}>{t(`collaboration.${event.action}`)}</Text>
              <Text selectable style={styles.mutedText}>
                {event.actorOxyUserId === playlist.ownerOxyUserId
                  ? playlist.ownerUsername
                  : (playlist.collaborators?.find(
                      (member) => member.oxyUserId === event.actorOxyUserId,
                    )?.username ?? event.actorOxyUserId)}{' '}
                · {new Date(event.createdAt).toLocaleString(i18n.language)}
              </Text>
            </View>
          ))}
          {activity.data?.items.length === 0 ? (
            <Text style={styles.mutedText}>{t('collaboration.noActivity')}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  container: { gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
  title: { fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  stack: { gap: 16 },
  mutedText: { color: t.mutedForeground },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  text: { color: t.primary },
  stack2: { gap: 8 },
  text2: { color: t.foreground },
  row2: { flexDirection: 'row', gap: 16 },
  text3: { color: t.error },
  title2: { fontWeight: 600, color: t.foreground },
  stack3: { gap: 4 },
}));
