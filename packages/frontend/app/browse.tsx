import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { ExploreSection } from '@/components/ExploreSection';
import { GenreCard } from '@/components/GenreCard';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { GenreGridSkeleton } from '@/components/skeletons';
import { browseService } from '@/services/browseService';
import { usePlayerStore } from '@/stores/playerStore';

const BrowseScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { startRadio } = usePlayerStore();

  const { data: genresData, isLoading: genresLoading, error: genresError, refetch: refetchGenres } = useQuery({
    queryKey: ['browse', 'genres'],
    queryFn: () => browseService.getGenres(),
    staleTime: 1000 * 60 * 10,
  });

  const genres = useMemo(() => genresData?.genres || [], [genresData]);

  const handleGenreClick = useCallback((genreName: string) => {
    router.push({ pathname: '/search', params: { q: genreName } });
  }, [router]);

  // A genre is a seed, not a fixed tracklist: play it as a station so it keeps
  // going past the first page instead of ending after 50 tracks.
  const handleGenrePlay = useCallback((genreName: string) => {
    startRadio({ seedType: 'genre', seedId: genreName });
  }, [startRadio]);

  return (
    <>
      <SEO
        title={t('browse.seo.title')}
        description={t('browse.seo.description')}
      />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <ExploreSection
            title={t('browse.all')}
            isLoading={genresLoading}
            isEmpty={genres.length === 0}
            error={genresError}
            onRetry={refetchGenres}
            loadingSkeleton={<GenreGridSkeleton count={16} />}
          >
            <ResponsiveGrid minItemWidth={160} gap={12}>
              {genres.map((genre) => (
                <View key={genre.name}>
                  <GenreCard
                    name={genre.name}
                    color={genre.color}
                    coverArt={genre.coverArt || undefined}
                    onPress={() => handleGenreClick(genre.name)}
                    onPlayPress={() => handleGenrePlay(genre.name)}
                  />
                </View>
              ))}
            </ResponsiveGrid>
          </ExploreSection>

          {/* Genres are derived from the catalogue, so an empty catalogue means
              an empty grid — and the grid is this screen's entire body. Unlike a
              rail that can quietly disappear from a populated page, hiding it
              here leaves nothing at all, so the screen says why once. */}
          {!genresLoading && !genresError && genres.length === 0 && (
            <EmptyState
              icon={{ name: 'musical-notes-outline' }}
              title={t('catalog.empty.title')}
              subtitle={t('catalog.empty.subtitle')}
              containerStyle={styles.emptyState}
            />
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
  contentContainer: {
    paddingTop: 18,
    paddingBottom: 100,
  },
  content: {
    paddingHorizontal: 18,
  },
  // `EmptyState` fills a screen by default; inside this scroll view it sizes to
  // its own content and lets the screen background show through.
  emptyState: {
    flex: 0,
    paddingVertical: 48,
    backgroundColor: 'transparent',
  },
});

export default BrowseScreen;
