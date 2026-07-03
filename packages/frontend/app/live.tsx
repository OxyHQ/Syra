import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@oxyhq/bloom/theme';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import {
  RoomCard,
  CreateRoomSheet,
  useLiveRoom,
  createAgoraService,
  type Room,
  type CreateRoomSheetRef,
  type CreateRoomFormState,
} from '@syra/live';

import SEO from '@/components/SEO';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';

/**
 * Live surface — the primary host/join screen for Syra audio rooms. Lists the
 * rooms that are live now and lets any signed-in user start their own. Joining a
 * room hands off to the `@syra/live` engine's floating dock + in-room UI (mounted
 * globally by `LiveRoomProvider`); this screen only surfaces the list + entry.
 */
export default function LiveScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { joinLiveRoom } = useLiveRoom();

  const agoraService = useMemo(() => createAgoraService(authenticatedClient), []);
  const {
    data: liveRooms = [],
    isRefetching,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: liveRoomsQueryKey,
    queryFn: () => agoraService.getRooms('live'),
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
  }, [closeCreateSheet, refetch]);

  return (
    <View className="flex-1" style={{ backgroundColor: theme.colors.background }}>
      <SEO title="Live - Syra" description="Join live audio rooms on Syra or start your own." />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={theme.colors.primary} />
        }
      >
        <View className="px-4 pb-3" style={{ paddingTop: insets.top + 12 }}>
          <View className="flex-row items-center gap-2">
            <View className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: theme.colors.error }} />
            <Text className="text-3xl font-extrabold" style={{ color: theme.colors.text }}>
              Live
            </Text>
          </View>
          <Text className="mt-1 text-base" style={{ color: theme.colors.textSecondary }}>
            Drop into a room, or start your own.
          </Text>
        </View>

        <Pressable
          onPress={openCreateSheet}
          className="mx-4 mb-4 flex-row items-center justify-center gap-2 rounded-full py-3"
          style={{ backgroundColor: theme.colors.primary }}
        >
          <MaterialCommunityIcons name="microphone-plus" size={20} color={theme.colors.primaryForeground} />
          <Text className="text-base font-semibold" style={{ color: theme.colors.primaryForeground }}>
            Start a room
          </Text>
        </Pressable>

        {isLoading ? (
          <View className="items-center justify-center py-16">
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : liveRooms.length > 0 ? (
          <View className="px-4 gap-3">
            {liveRooms.map((room: Room) => (
              <RoomCard key={room._id} room={room} onPress={() => joinLiveRoom(room._id)} />
            ))}
          </View>
        ) : (
          <View className="items-center justify-center px-8 py-16">
            <MaterialCommunityIcons name="broadcast-off" size={56} color={theme.colors.textTertiary} />
            <Text className="mt-4 text-lg font-semibold" style={{ color: theme.colors.text }}>
              No live rooms right now
            </Text>
            <Text className="mt-1 text-center text-sm" style={{ color: theme.colors.textSecondary }}>
              Be the first to go live — start a room and invite people to listen and talk.
            </Text>
          </View>
        )}
      </ScrollView>

      <BottomSheet ref={sheetRef} enablePanDownToClose style={{ maxWidth: 500, marginHorizontal: 'auto' }}>
        <CreateRoomSheet
          ref={createRef}
          onClose={closeCreateSheet}
          onRoomCreated={handleRoomCreated}
          hideFooter
          onFormStateChange={setFormState}
        />
        <View
          className="gap-2.5 px-4 pt-2.5 pb-3.5"
          style={{ borderTopWidth: 0.5, borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }}
        >
          <Pressable
            onPress={() => createRef.current?.handleCreateAndStart()}
            disabled={!formState.isValid || formState.loading}
            className="flex-row items-center justify-center gap-1.5 rounded-full py-3"
            style={{
              backgroundColor: formState.isValid ? theme.colors.primary : theme.colors.backgroundSecondary,
              opacity: formState.loading ? 0.6 : 1,
            }}
          >
            <MaterialCommunityIcons
              name="play"
              size={20}
              color={formState.isValid ? theme.colors.primaryForeground : theme.colors.textSecondary}
            />
            <Text
              className="text-base font-semibold"
              style={{ color: formState.isValid ? theme.colors.primaryForeground : theme.colors.textSecondary }}
            >
              {formState.loading ? 'Creating…' : 'Start now'}
            </Text>
          </Pressable>

          {formState.hasScheduledStart && (
            <Pressable
              onPress={() => createRef.current?.handleSchedule()}
              disabled={!formState.isValid || formState.loading}
              className="flex-row items-center justify-center gap-1.5 rounded-full py-3"
              style={{
                backgroundColor: theme.colors.backgroundSecondary,
                borderWidth: 1,
                borderColor: theme.colors.border,
                opacity: formState.loading ? 0.6 : 1,
              }}
            >
              <MaterialCommunityIcons name="calendar" size={20} color={theme.colors.text} />
              <Text className="text-base font-semibold" style={{ color: theme.colors.text }}>
                Schedule room
              </Text>
            </Pressable>
          )}
        </View>
      </BottomSheet>
    </View>
  );
}
