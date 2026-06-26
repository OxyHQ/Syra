import React, { useState } from 'react';
import { StyleSheet, View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import SEO from '@/components/SEO';
import { usePodcastDiscovery, useImportFeed } from '@/hooks/usePodcasts';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { resolvePodcastImageUri } from '@/utils/podcastImages';
import type { PodcastDirectoryCandidate } from '@/services/podcastDiscoveryService';

/**
 * Podcast directory search. Queries Podcast Index + Apple via the backend; tapping
 * a result imports its feed into the catalog and opens the resulting show.
 */
const PodcastDiscoverScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 350);
  const [importingFeed, setImportingFeed] = useState<string | null>(null);

  const discoveryQuery = usePodcastDiscovery(debouncedQuery);
  const importFeed = useImportFeed();

  const handleSelect = async (candidate: PodcastDirectoryCandidate) => {
    if (importFeed.isPending) {
      return;
    }
    setImportingFeed(candidate.feedUrl);
    try {
      const podcast = await importFeed.mutateAsync(candidate.feedUrl);
      router.replace({ pathname: '/podcasts/[id]', params: { id: podcast.id } });
    } catch {
      // Errors are surfaced via the mutation's toast; reset the row state.
      setImportingFeed(null);
    }
  };

  const candidates = discoveryQuery.data ?? [];

  return (
    <>
      <SEO title="Find podcasts - Syra" description="Search the podcast directory" />
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="chevron-back" size={24} color={theme.colors.text} />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>Find a podcast</Text>
        </View>

        <View style={[styles.searchBar, { backgroundColor: theme.colors.backgroundTertiary }]}>
          <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search shows, hosts, topics…"
            placeholderTextColor={theme.colors.textSecondary}
            style={[styles.searchInput, { color: theme.colors.text }]}
            autoFocus
            returnKeyType="search"
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
            </Pressable>
          )}
        </View>

        <ScrollView
          style={styles.results}
          contentContainerStyle={styles.resultsContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {discoveryQuery.isFetching && candidates.length === 0 && (
            <ActivityIndicator color={theme.colors.primary} style={styles.loading} />
          )}

          {!discoveryQuery.isFetching && debouncedQuery.trim().length > 1 && candidates.length === 0 && (
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              No shows found for “{debouncedQuery.trim()}”.
            </Text>
          )}

          {candidates.map((candidate) => {
            const imageUri = resolvePodcastImageUri(candidate.image, 'thumb');
            const isImporting = importingFeed === candidate.feedUrl;
            return (
              <Pressable
                key={candidate.feedUrl}
                onPress={() => handleSelect(candidate)}
                disabled={importFeed.isPending}
                style={[styles.row, { opacity: importFeed.isPending && !isImporting ? 0.5 : 1 }]}
              >
                {imageUri ? (
                  <Image source={{ uri: imageUri }} style={styles.artwork} contentFit="cover" />
                ) : (
                  <View style={[styles.artworkPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                    <Ionicons name="mic" size={22} color={theme.colors.textSecondary} />
                  </View>
                )}
                <View style={styles.rowBody}>
                  <Text style={[styles.rowTitle, { color: theme.colors.text }]} numberOfLines={1}>
                    {candidate.title}
                  </Text>
                  {candidate.author ? (
                    <Text style={[styles.rowAuthor, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                      {candidate.author}
                    </Text>
                  ) : null}
                </View>
                {isImporting ? (
                  <ActivityIndicator color={theme.colors.primary} />
                ) : (
                  <Ionicons name="add-circle-outline" size={24} color={theme.colors.primary} />
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  title: {
    fontSize: 22,
    fontWeight: 'bold',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 22,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  results: {
    flex: 1,
    marginTop: 12,
  },
  resultsContent: {
    paddingBottom: 120,
    gap: 4,
  },
  loading: {
    marginTop: 32,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  artwork: {
    width: 56,
    height: 56,
    borderRadius: 8,
  },
  artworkPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowAuthor: {
    fontSize: 13,
  },
});

export default PodcastDiscoverScreen;
