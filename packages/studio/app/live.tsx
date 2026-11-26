import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Button } from '@oxy.so/bloom/button';
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
} from '@syra.fm/sdk';

import { ScreenContainer } from '@/components/AppShell';
import { SignInGate } from '@/components/SignInGate';
import { authenticatedClient } from '@/utils/api';
import { liveRoomsQueryKey } from '@/lib/liveConfig';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/**
 * Studio "Go Live" entry. A creator-flavored surface over the SAME `@syra.fm/sdk`
 * engine the listener app uses: it leads with a prominent "Go Live" action that
 * opens the shared `CreateRoomSheet`, and lists any rooms that are live now so a
 * creator can hop into one. Joining hands off to the engine's globally-mounted
 * floating dock + in-room UI.
 */
function GoLive() {
  const styles = useStyles();
  const theme = useTheme();
  const { joinLiveRoom } = useLiveRoom();

  const roomsService = useMemo(() => createRoomsService(authenticatedClient), []);
  const {
    data: liveRooms = [],
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
  }, [closeCreateSheet, refetch]);

  return (
    <>
      <ScreenContainer title="Go Live" subtitle="Host a live audio room for your listeners.">
        <View style={styles.surface}>
          <View style={styles.row}>
            <MaterialCommunityIcons name="access-point" size={20} color={theme.colors.primary} />
            <Text style={styles.title}>Start a live room</Text>
          </View>
          <Text style={styles.mutedText}>
            Go on air instantly, or schedule a room for later. Listeners can join, request to speak,
            and you can record.
          </Text>
          <Button
            fullWidth
            onPress={openCreateSheet}
            icon={
              <MaterialCommunityIcons
                name="microphone-plus"
                size={18}
                color={theme.colors.primaryForeground}
              />
            }
            tone="accent"
            appearance="solid"
          >
            Go Live
          </Button>
        </View>

        <Text style={styles.mutedText2}>Live now</Text>
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
              size={44}
              color={theme.colors.textTertiary}
            />
            <Text style={styles.mutedText3}>
              No rooms are live right now. Be the first to go on air.
            </Text>
          </View>
        )}
      </ScreenContainer>

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
        <View
          style={[
            styles.container,
            {
              borderTopWidth: 0.5,
              borderTopColor: theme.colors.border,
              backgroundColor: theme.colors.background,
            },
          ]}
        >
          <Button
            fullWidth
            disabled={!formState.isValid}
            loading={formState.loading}
            onPress={() => createRef.current?.handleCreateAndStart()}
            icon={
              <MaterialCommunityIcons
                name="play"
                size={18}
                color={theme.colors.primaryForeground}
              />
            }
            tone="accent"
            appearance="solid"
          >
            Start now
          </Button>
          {formState.hasScheduledStart && (
            <Button
              fullWidth
              disabled={!formState.isValid || formState.loading}
              onPress={() => createRef.current?.handleSchedule()}
              icon={<MaterialCommunityIcons name="calendar" size={18} color={theme.colors.text} />}
              tone="neutral"
              appearance="outline"
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

const useStyles = createTokenStyles((t) => ({
  surface: {
    marginBottom: 24,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    padding: 20,
  },
  row: { marginBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 18, fontWeight: 700, color: t.foreground, lineHeight: 28 },
  mutedText: { marginBottom: 16, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  mutedText2: {
    marginBottom: 12,
    fontSize: 14,
    fontWeight: 600,
    color: t.mutedForeground,
    textTransform: 'uppercase',
    lineHeight: 20,
    letterSpacing: 0.35,
  },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
  stack: { gap: 12 },
  centered2: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
  mutedText3: {
    marginTop: 12,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  container: { gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 14 },
}));
