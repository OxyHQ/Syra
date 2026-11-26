import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import BottomSheet, { type BottomSheetRef } from '@oxy.so/bloom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import {
  RoomCard,
  CreateRoomSheet,
  useLiveRoom,
  createRoomsService,
  type Room,
  type CreateRoomSheetRef,
  type CreateRoomFormState,
} from '@syra.fm/sdk/live';

import SEO from '@/components/SEO';
import { refreshLiveRoomsWidget } from '@/modules/syra-widgets';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * Live surface — the primary host/join screen for Syra audio rooms. Lists the
 * rooms that are live now and lets any signed-in user start their own. Joining a
 * room hands off to the `@syra.fm/sdk` engine's floating dock + in-room UI (mounted
 * globally by `LiveRoomProvider`); this screen only surfaces the list + entry.
 */
export default function LiveScreen() {
  const styles = useStyles();
  const { t } = useTranslation();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { joinLiveRoom } = useLiveRoom();

  const roomsService = useMemo(() => createRoomsService(authenticatedClient), []);
  const {
    data: liveRooms = [],
    isRefetching,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: liveRoomsQueryKey,
    queryFn: () => roomsService.getRooms('live'),
    staleTime: 30_000,
  });

  const sheetRef = useRef<BottomSheetRef>(null);
  const createRef = useRef<CreateRoomSheetRef>(null);
  const [formState, setFormState] = useState<CreateRoomFormState>({
    isValid: false,
    loading: false,
    hasScheduledStart: false,
  });

  const openCreateSheet = useCallback(() => {
    sheetRef.current?.present();
  }, []);

  const closeCreateSheet = useCallback(() => {
    sheetRef.current?.dismiss();
  }, []);

  const handleRoomCreated = useCallback(() => {
    closeCreateSheet();
    refetch();
    // The home-screen widget polls on WorkManager's 15-minute floor, so without
    // a nudge the user's own new room would be missing from their home screen
    // for up to a quarter of an hour. No-ops on web and on any build without the
    // native module.
    void refreshLiveRoomsWidget();
  }, [closeCreateSheet, refetch]);

  return (
    <View style={styles.surface}>
      <SEO title={t('live.seo.title')} description={t('live.seo.description')} />

      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => {
              refetch();
            }}
            tintColor={theme.colors.primary}
          />
        }
      >
        <View style={[styles.section, { paddingTop: insets.top + 12 }]}>
          <View style={styles.row}>
            <View style={styles.surface2} />
            <Text style={styles.title}>{t('live.title')}</Text>
          </View>
          <Text style={styles.mutedText}>{t('live.subtitle')}</Text>
        </View>

        <Pressable onPress={openCreateSheet} style={styles.row2}>
          <MaterialCommunityIcons
            name="microphone-plus"
            size={20}
            color={theme.colors.primaryForeground}
          />
          <Text style={styles.title2}>{t('live.startRoom')}</Text>
        </Pressable>

        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : liveRooms.length > 0 ? (
          <View style={styles.stack}>
            {liveRooms.map((room: Room) => (
              <RoomCard key={room.id} room={room} onPress={() => joinLiveRoom(room.id)} />
            ))}
          </View>
        ) : (
          <View style={styles.centered2}>
            <MaterialCommunityIcons
              name="broadcast-off"
              size={56}
              color={theme.colors.textTertiary}
            />
            <Text style={styles.title3}>{t('live.empty')}</Text>
            <Text style={styles.mutedText2}>{t('live.emptySubtitle')}</Text>
          </View>
        )}
      </ScrollView>

      <BottomSheet
        ref={sheetRef}
        enablePanDownToClose
        style={{ maxWidth: 500, marginHorizontal: 'auto' }}
      >
        <CreateRoomSheet
          ref={createRef}
          onClose={closeCreateSheet}
          onRoomCreated={handleRoomCreated}
          hideFooter
          onFormStateChange={setFormState}
        />
        <View style={[styles.surface3, { borderTopWidth: 0.5 }]}>
          <Pressable
            onPress={() => createRef.current?.handleCreateAndStart()}
            disabled={!formState.isValid || formState.loading}
            style={[
              styles.row3,
              {
                backgroundColor: formState.isValid
                  ? theme.colors.primary
                  : theme.colors.backgroundSecondary,
                opacity: formState.loading ? 0.6 : 1,
              },
            ]}
          >
            <MaterialCommunityIcons
              name="play"
              size={20}
              color={
                formState.isValid ? theme.colors.primaryForeground : theme.colors.textSecondary
              }
            />
            <Text
              style={[
                styles.title4,
                {
                  color: formState.isValid
                    ? theme.colors.primaryForeground
                    : theme.colors.textSecondary,
                },
              ]}
            >
              {formState.loading ? t('live.creating') : t('live.startNow')}
            </Text>
          </Pressable>

          {formState.hasScheduledStart && (
            <Pressable
              onPress={() => createRef.current?.handleSchedule()}
              disabled={!formState.isValid || formState.loading}
              className={`flex-row items-center justify-center gap-1.5 rounded-full py-3 bg-surface border-border ${formState.loading ? 'opacity-60' : 'opacity-100'}`}
              style={{ borderWidth: 1 }}
            >
              <MaterialCommunityIcons name="calendar" size={20} color={theme.colors.text} />
              <Text style={styles.title5}>{t('live.scheduleRoom')}</Text>
            </Pressable>
          )}
        </View>
      </BottomSheet>
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  section: { paddingHorizontal: 16, paddingBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  surface2: { height: 10, width: 10, borderRadius: 9999, backgroundColor: t.error },
  title: { fontSize: 30, fontWeight: 800, color: t.foreground, lineHeight: 36 },
  mutedText: { marginTop: 4, fontSize: 16, color: t.mutedForeground, lineHeight: 24 },
  row2: {
    marginHorizontal: 16,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 9999,
    backgroundColor: t.primary,
    paddingVertical: 12,
  },
  title2: { fontSize: 16, fontWeight: 600, color: t.primaryForeground, lineHeight: 24 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 64 },
  stack: { gap: 12, paddingHorizontal: 16 },
  centered2: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 64,
  },
  title3: { marginTop: 16, fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText2: {
    marginTop: 4,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  surface3: {
    gap: 10,
    borderTopColor: t.border,
    backgroundColor: t.background,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
  },
  row3: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 9999,
    paddingVertical: 12,
  },
  title4: { fontSize: 16, fontWeight: 600, lineHeight: 24 },
  title5: { fontSize: 16, fontWeight: 600, color: t.foreground, lineHeight: 24 },
}));
