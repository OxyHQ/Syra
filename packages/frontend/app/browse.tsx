import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { useRouter } from 'expo-router';
import SEO from '@/components/SEO';
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
            emptyMessage="No genres available"
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
});

export default BrowseScreen;
