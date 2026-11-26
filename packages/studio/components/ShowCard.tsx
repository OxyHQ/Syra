import { Pressable, Text, View } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Podcast } from '@syra/shared-types';
import { Artwork } from '@/components/Artwork';
import { StatusBadge } from '@/components/StatusBadge';
import { pluralEpisodes } from '@/utils/format';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export function ShowCard({ podcast, onPress }: { podcast: Podcast; onPress: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  const episodeLabel = pluralEpisodes(podcast.episodeCount);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <Artwork uri={podcast.image} size={64} rounded="xl" />
      <View style={styles.fill}>
        <View style={styles.row}>
          <Text numberOfLines={1} style={styles.title}>
            {podcast.title}
          </Text>
          <StatusBadge status={podcast.status} />
        </View>
        {podcast.author ? (
          <Text numberOfLines={1} style={styles.mutedText}>
            {podcast.author}
          </Text>
        ) : null}
        <Text style={styles.mutedText2}>{episodeLabel}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

const useStyles = createTokenStyles((t) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    padding: 12,
  },
  pressed: { opacity: 0.8 },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 16,
    fontWeight: 600,
    color: t.foreground,
    lineHeight: 24,
  },
  mutedText: { marginTop: 2, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  mutedText2: { marginTop: 4, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
}));
