import React from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Image } from 'expo-image';
import { musicService } from '@/services/musicService';
import { useAuthGate } from '@/hooks/useAuthGate';
import { usePlayerStore } from '@/stores/playerStore';
import { TrackCredits } from '@/components/TrackCredits';
import { LyricsView } from '@/components/LyricsView';
import { TrackArtistLine } from '@/components/TrackArtistLine';
import { TrackActionsSheet } from '@/components/playlist/TrackActionsSheet';
import { pickCatalogImageUrl } from '@/utils/pickImage';
import { shareMedia } from '@/utils/share-media';
import SEO from '@/components/SEO';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function TrackScreen() {
  const styles = useStyles();
  const { id, t: timestamp } = useLocalSearchParams<{ id: string; t?: string }>();
  const { t } = useTranslation();
  const gate = useAuthGate();
  const [showActions, setShowActions] = React.useState(false);
  const query = useQuery({
    queryKey: ['track-detail', id, gate.catalogIdentity],
    queryFn: () => musicService.getTrackById(id),
    enabled: Boolean(id) && gate.isResolved,
  });
  const track = query.data;
  const playing = usePlayerStore((state) => state.currentTrack?.id === id && state.isPlaying);
  const handlePlay = async () => {
    if (!track) return;
    const player = usePlayerStore.getState();
    if (player.currentTrack?.id === id) {
      await (player.isPlaying ? player.pause() : player.resume());
      return;
    }
    await player.playTrack(track, { type: 'track', id, name: track.title });
    const position = Number(timestamp);
    if (
      Number.isFinite(position) &&
      position > 0 &&
      usePlayerStore.getState().currentTrack?.id === id
    ) {
      await usePlayerStore.getState().seek(Math.min(position, Math.max(0, track.duration - 1)));
    }
  };
  return (
    <ScrollView
      style={styles.surface}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: track?.title ?? t('listener.track') }} />
      {gate.isResolving || query.isLoading ? <ActivityIndicator /> : null}
      {query.isError || gate.isTimedOut ? (
        <Pressable
          onPress={() => {
            gate.retry();
            void query.refetch();
          }}
        >
          <Text style={styles.text}>{t('listener.retry')}</Text>
        </Pressable>
      ) : null}
      {track ? (
        <>
          <SEO
            title={track.title}
            description={track.artistName}
            image={pickCatalogImageUrl(
              track.images,
              track.coverArt,
              'detailArtwork',
              track.coverArtSizes,
            )}
          />
          {/* TODO(lead): native artwork size. The classes `w-64 h-64 rounded-2xl` reached
              only the web: there expo-image's container is react-native-css's `View`, on
              native the class went to expo-image's native view, which ignores it, so the
              artwork has no size there and draws at zero height. Kept as it drew. */}
          <Image
            source={{
              uri: pickCatalogImageUrl(
                track.images,
                track.coverArt,
                'detailArtwork',
                track.coverArtSizes,
              ),
            }}
            style={styles.artwork}
            contentFit="cover"
          />
          <Text selectable style={styles.title}>
            {track.title}
          </Text>
          <TrackArtistLine track={track} style={styles.artist} />
          <View style={styles.row}>
            <Pressable
              onPress={() => void handlePlay()}
              accessibilityRole="button"
              style={styles.surface2}
            >
              <Text style={styles.title2}>{t(playing ? 'listener.pause' : 'listener.play')}</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowActions(true)}
              accessibilityRole="button"
              style={styles.surface3}
            >
              <Text style={styles.text}>{t('listener.actions')}</Text>
            </Pressable>
            <Pressable
              onPress={() => void shareMedia('track', id, track.title)}
              accessibilityRole="button"
              style={styles.surface3}
            >
              <Text style={styles.text}>{t('listener.share')}</Text>
            </Pressable>
          </View>
          <TrackCredits track={track} />
          <Text style={styles.title3}>{t('listener.lyrics')}</Text>
          <LyricsView trackId={id} />
          <TrackActionsSheet
            visible={showActions}
            onClose={() => setShowActions(false)}
            track={track}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  content: { gap: 20, padding: 24, paddingBottom: 144 },
  text: { color: t.foreground },
  title: { fontSize: 30, fontWeight: 700, color: t.foreground, lineHeight: 36 },
  artist: { fontSize: 18, lineHeight: 28, color: t.mutedForeground },
  artwork: Platform.select({ web: { width: 256, height: 256, borderRadius: 16 }, default: {} }),
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  surface2: {
    borderRadius: 9999,
    backgroundColor: t.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  title2: { fontWeight: 600, color: t.primaryForeground },
  surface3: {
    borderRadius: 9999,
    backgroundColor: t.surface,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  title3: { fontSize: 20, fontWeight: 600, color: t.foreground, lineHeight: 28 },
}));
