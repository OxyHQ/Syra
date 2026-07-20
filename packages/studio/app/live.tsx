import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { Button } from '@oxyhq/bloom/button';
import BottomSheet, { type BottomSheetRef } from '@oxyhq/bloom/bottom-sheet';
import { useQuery } from '@tanstack/react-query';
import {
  RoomCard,
  CreateRoomSheet,
  useLiveRoom,
  createRoomsService,
  type Room,
  type CreateRoomSheetRef,
  type CreateRoomFormState,
} from '@syra.fm/sdk';

import { ScreenContainer } from '@/components/AppShell';
import { SignInGate } from '@/components/SignInGate';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';

/**
 * Studio "Go Live" entry. A creator-flavored surface over the SAME `@syra.fm/sdk`
 * engine the listener app uses: it leads with a prominent "Go Live" action that
 * opens the shared `CreateRoomSheet`, and lists any rooms that are live now so a
 * creator can hop into one. Joining hands off to the engine's globally-mounted
 * floating dock + in-room UI.
 */
function GoLive() {
  const theme = useTheme();
  const { joinLiveRoom } = useLiveRoom();

  const roomsService = useMemo(() => createRoomsService(authenticatedClient), []);
  const { data: liveRooms = [], isLoading, refetch } = useQuery({
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
  }, [closeCreateSheet, refetch]);

  return (
    <>
      <ScreenContainer title="Go Live" subtitle="Host a live audio room for your listeners.">
        <View className="rounded-2xl border border-border bg-surface p-5 mb-6">
          <View className="flex-row items-center gap-2 mb-1">
            <MaterialCommunityIcons name="access-point" size={20} color={theme.colors.primary} />
            <Text className="text-lg font-bold text-foreground">Start a live room</Text>
          </View>
          <Text className="text-sm text-muted-foreground mb-4">
            Go on air instantly, or schedule a room for later. Listeners can join, request to speak, and you can record.
          </Text>
          <Button
            variant="primary"
            fullWidth
            onPress={openCreateSheet}
            icon={<MaterialCommunityIcons name="microphone-plus" size={18} color={theme.colors.primaryForeground} />}
          >
            Go Live
          </Button>
        </View>

        <Text className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wide">Live now</Text>
        {isLoading ? (
          <View className="items-center justify-center py-12">
            <ActivityIndicator color={theme.colors.primary} />
          </View>
        ) : liveRooms.length > 0 ? (
          <View className="gap-3">
            {liveRooms.map((room: Room) => (
              <RoomCard key={room._id} room={room} onPress={() => joinLiveRoom(room._id)} />
            ))}
          </View>
        ) : (
          <View className="items-center justify-center py-10">
            <MaterialCommunityIcons name="broadcast-off" size={44} color={theme.colors.textTertiary} />
            <Text className="mt-3 text-sm text-muted-foreground text-center">
              No rooms are live right now. Be the first to go on air.
            </Text>
          </View>
        )}
      </ScreenContainer>

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
          <Button
            variant="primary"
            fullWidth
            disabled={!formState.isValid}
            loading={formState.loading}
            onPress={() => createRef.current?.handleCreateAndStart()}
            icon={<MaterialCommunityIcons name="play" size={18} color={theme.colors.primaryForeground} />}
          >
            Start now
          </Button>
          {formState.hasScheduledStart && (
            <Button
              variant="outline"
              fullWidth
              disabled={!formState.isValid || formState.loading}
              onPress={() => createRef.current?.handleSchedule()}
              icon={<MaterialCommunityIcons name="calendar" size={18} color={theme.colors.text} />}
            >
              Schedule room
            </Button>
          )}
        </View>
      </BottomSheet>
    </>
  );
}

export default function LiveScreen() {
  return (
    <SignInGate>
      <GoLive />
    </SignInGate>
  );
}
