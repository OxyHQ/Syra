import { Pressable, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import type { Podcast } from '@syra/shared-types';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';

export function ShowCard({ podcast, onPress }: { podcast: Podcast; onPress: () => void }) {
  const theme = useTheme();
  const episodeLabel = `${podcast.episodeCount} ${podcast.episodeCount === 1 ? 'episode' : 'episodes'}`;
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-4 rounded-2xl border border-border bg-surface p-3 active:opacity-80"
    >
      <Artwork uri={podcast.image} size={64} rounded="xl" />
      <View className="flex-1">
        <View className="flex-row items-center gap-2">
          <Text numberOfLines={1} className="text-base font-semibold text-foreground flex-1">
            {podcast.title}
          </Text>
          <StatusBadge status={podcast.status} />
        </View>
        {podcast.author ? (
          <Text numberOfLines={1} className="text-sm text-muted-foreground mt-0.5">
            {podcast.author}
          </Text>
        ) : null}
        <Text className="text-xs text-muted-foreground mt-1">{episodeLabel}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
    </Pressable>
  );
}
