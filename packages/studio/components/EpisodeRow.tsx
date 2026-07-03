import { Text, View } from 'react-native';
import type { Episode } from '@syra/shared-types';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDate, formatDuration } from '@/utils/format';

/**
 * One episode in the show-detail list. The creator (owner) sees every status,
 * including `processing` and `failed`, so they can track ingest progress.
 */
export function EpisodeRow({ episode }: { episode: Episode }) {
  const meta = [formatDate(episode.pubDate), formatDuration(episode.duration)].filter(Boolean).join(' · ');
  return (
    <View className="flex-row items-center gap-3 py-3 border-b border-border">
      <Artwork uri={episode.image} size={48} rounded="lg" />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-sm font-medium text-foreground">
          {episode.title}
        </Text>
        {meta ? <Text className="text-xs text-muted-foreground mt-0.5">{meta}</Text> : null}
      </View>
      <StatusBadge status={episode.status} />
    </View>
  );
}
