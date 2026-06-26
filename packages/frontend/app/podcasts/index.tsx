import React, { useState, useMemo } from 'react';
import { StyleSheet, View, Text, ScrollView, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import SEO from '@/components/SEO';
import { MediaCard } from '@/components/MediaCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { MediaCardRowSkeleton } from '@/components/skeletons';
import { usePodcasts, useContinueListening } from '@/hooks/usePodcasts';
import { usePlayerStore } from '@/stores/playerStore';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import { formatRemaining } from '@/utils/podcastFormat';
import { webViewStyle } from '@/utils/webStyles';

/** Apple top-level podcast categories surfaced as quick browse chips. */
const PODCAST_CATEGORIES = [
  'News',
  'Comedy',
  'Technology',
  'Business',
  'Society & Culture',
  'Education',
  'Sports',
  'Health & Fitness',
  'True Crime',
  'Music',
] as const;

/**
 * Podcasts home — continue-listening rail, category chips, and a popular/recent
 * browse grid sourced entirely from the Syra catalog. A directory search entry
 * point lets users pull in shows that are not yet mirrored.
 */
const PodcastsScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  const browseQuery = usePodcasts(
    activeCategory ? { category: activeCategory, sort: 'popular' } : { sort: 'popular' },
  );
  const continueQuery = useContinueListening();

  const playEpisode = usePlayerStore((s) => s.playEpisode);

  const podcasts = browseQuery.data ?? [];
  const inProgress = useMemo(
    () => (continueQuery.data ?? []).filter((entry) => !entry.completed),
    [continueQuery.data],
  );

  return (
    <>
      <SEO title="Podcasts - Syra" description="Discover and listen to podcasts on Syra" />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Podcasts</Text>
          <Pressable
            onPress={() => router.push('/podcasts/discover')}
            style={[styles.discoverButton, { backgroundColor: theme.colors.backgroundTertiary }]}
            accessibilityRole="button"
            accessibilityLabel="Find podcasts"
          >
            <Ionicons name="search" size={16} color={theme.colors.text} />
            <Text style={[styles.discoverText, { color: theme.colors.text }]}>Find a podcast</Text>
          </Pressable>
        </View>

        {/* Continue listening rail */}
        {inProgress.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Continue listening</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.rail}
            >
              {inProgress.map((entry) => (
                <View key={entry.episode.id} style={styles.railItem}>
                  <MediaCard
                    title={entry.episode.title}
                    subtitle={formatRemaining(entry.progressSec, entry.durationSec)}
                    type="podcast"
                    resolvedImageUri={resolvePodcastImageUri(entry.episode.image, 'medium')}
                    onPress={() => router.push({ pathname: '/episode/[id]', params: { id: entry.episode.id } })}
                    onPlayPress={() => playEpisode(entry.episode, { resumeFromSec: entry.progressSec })}
                  />
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Category chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          <Pressable
            onPress={() => setActiveCategory(null)}
            style={[
              styles.chip,
              { backgroundColor: activeCategory === null ? theme.colors.primary : theme.colors.backgroundTertiary },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                { color: activeCategory === null ? theme.colors.primaryForeground : theme.colors.text },
              ]}
            >
              All
            </Text>
          </Pressable>
          {PODCAST_CATEGORIES.map((category) => {
            const isActive = activeCategory === category;
            return (
              <Pressable
                key={category}
                onPress={() => setActiveCategory(isActive ? null : category)}
                style={[
                  styles.chip,
                  { backgroundColor: isActive ? theme.colors.primary : theme.colors.backgroundTertiary },
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    { color: isActive ? theme.colors.primaryForeground : theme.colors.text },
                  ]}
                >
                  {category}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Browse grid */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {activeCategory ?? 'Popular shows'}
          </Text>
          {browseQuery.isPending ? (
            <MediaCardRowSkeleton count={8} />
          ) : podcasts.length > 0 ? (
            <ResponsiveGrid minItemWidth={160} gap={12}>
              {podcasts.map((podcast) => (
                <View key={podcast.id}>
                  <MediaCard
                    title={podcast.title}
                    subtitle={podcast.author ?? 'Podcast'}
                    type="podcast"
                    resolvedImageUri={resolvePodcastImageUri(podcast.image, 'medium')}
                    onPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                    onPlayPress={() => router.push({ pathname: '/podcasts/[id]', params: { id: podcast.id } })}
                  />
                </View>
              ))}
            </ResponsiveGrid>
          ) : (
            <View style={styles.empty}>
              <Ionicons name="mic-outline" size={48} color={theme.colors.textSecondary} />
              <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                No shows here yet. Try finding a podcast to add it to the catalog.
              </Text>
              <Pressable
                onPress={() => router.push('/podcasts/discover')}
                style={[styles.emptyButton, { backgroundColor: theme.colors.primary }]}
              >
                <Text style={[styles.emptyButtonText, { color: theme.colors.primaryForeground }]}>
                  Find a podcast
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 120,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  discoverButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  discoverText: {
    fontSize: 13,
    fontWeight: '600',
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  rail: {
    gap: 12,
  },
  railItem: {
    width: 160,
  },
  chips: webViewStyle({
    gap: 8,
    paddingBottom: 20,
  }),
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    marginRight: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  empty: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 40,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    maxWidth: 320,
  },
  emptyButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  emptyButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default PodcastsScreen;
