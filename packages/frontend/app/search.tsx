import React, { useState, useMemo, useCallback } from 'react';
import { StyleSheet, View, TextInput, Text, ScrollView, Platform, Pressable, ActivityIndicator } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@/hooks/useTheme';
import SEO from '@/components/SEO';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SearchCategory, SearchResult, Track, Album, Artist, Playlist } from '@syra/shared-types';
import { searchService } from '@/services/searchService';
import { browseService, Genre } from '@/services/browseService';
import { MediaCard } from '@/components/MediaCard';
import { GenreCard } from '@/components/GenreCard';
import { TrackRow } from '@/components/TrackRow';
import { ExploreSection } from '@/components/ExploreSection';
import { usePlayerStore } from '@/stores/playerStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

/**
 * Syra Search Screen
 * Spotify-like search interface for tracks, albums, artists, and playlists
 */
const SearchScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { playTrack, currentTrack, isPlaying } = usePlayerStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<SearchCategory>(SearchCategory.ALL);

  // Debounce search query
  const debouncedQuery = useDebouncedValue(searchQuery, 300);
  const hasQuery = debouncedQuery.trim().length > 0;

  // React Query hooks for explore data - only enabled when no search query
  // Each query loads independently for progressive rendering
  const { data: genresData, isLoading: genresLoading } = useQuery({
    queryKey: ['browse', 'genres'],
    queryFn: () => browseService.getGenres(),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10, // 10 minutes
  });

  const { data: popularTracksData, isLoading: popularTracksLoading } = useQuery({
    queryKey: ['browse', 'popular', 'tracks'],
    queryFn: () => browseService.getPopularTracks({ limit: 6 }),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10,
  });

  const { data: popularAlbumsData, isLoading: popularAlbumsLoading } = useQuery({
    queryKey: ['browse', 'popular', 'albums'],
    queryFn: () => browseService.getPopularAlbums({ limit: 8 }),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10,
  });

  const { data: popularArtistsData, isLoading: popularArtistsLoading } = useQuery({
    queryKey: ['browse', 'popular', 'artists'],
    queryFn: () => browseService.getPopularArtists({ limit: 8 }),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10,
  });

  const { data: madeForYouData, isLoading: madeForYouLoading } = useQuery({
    queryKey: ['browse', 'made-for-you'],
    queryFn: () => browseService.getMadeForYou({ limit: 8 }),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10,
  });

  const { data: chartsData, isLoading: chartsLoading } = useQuery({
    queryKey: ['browse', 'charts'],
    queryFn: () => browseService.getCharts({ limit: 10 }),
    enabled: !hasQuery,
    staleTime: 1000 * 60 * 10,
  });

  // Search query - only enabled when there's a search query
  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['search', debouncedQuery, activeCategory],
    queryFn: () => searchService.search(debouncedQuery, {
      category: activeCategory,
      limit: 20,
      offset: 0,
    }),
    enabled: hasQuery,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Memoize explore data
  const genres = useMemo(() => genresData?.genres || [], [genresData]);
  const popularTracks = useMemo(() => popularTracksData?.tracks || [], [popularTracksData]);
  const popularAlbums = useMemo(() => popularAlbumsData?.albums || [], [popularAlbumsData]);
  const popularArtists = useMemo(() => popularArtistsData?.artists || [], [popularArtistsData]);
  const madeForYouAlbums = useMemo(() => madeForYouData?.albums || [], [madeForYouData]);
  const madeForYouPlaylists = useMemo(() => madeForYouData?.playlists || [], [madeForYouData]);
  const chartsTracks = useMemo(() => chartsData?.tracks || [], [chartsData]);

  // Memoized event handlers
  const handleTrackPress = useCallback((track: Track) => {
    playTrack(track);
  }, [playTrack]);

  const handleTrackRowPress = useCallback((track: Track) => {
    if (track.albumId) {
      router.push(`/album/${track.albumId}`);
    } else {
      playTrack(track);
    }
  }, [router, playTrack]);

  const handleGenreClick = useCallback((genreName: string) => {
    setSearchQuery(genreName);
  }, []);

  const handleCategoryChange = useCallback((category: SearchCategory) => {
    setActiveCategory(category);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  // Memoized categories
  const categories: { value: SearchCategory; label: string }[] = useMemo(() => [
    { value: SearchCategory.ALL, label: 'All' },
    { value: SearchCategory.TRACKS, label: 'Tracks' },
    { value: SearchCategory.ALBUMS, label: 'Albums' },
    { value: SearchCategory.ARTISTS, label: 'Artists' },
    { value: SearchCategory.PLAYLISTS, label: 'Playlists' },
  ], []);

  // Memoized computed values
  const showResults = useMemo(() => searchResults && hasQuery, [searchResults, hasQuery]);
  const hasResults = useMemo(() => searchResults && searchResults.counts.total > 0, [searchResults]);

  return (
    <>
      <SEO
        title="Search - Syra"
        description="Search for music"
      />
      <ScrollView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* Search Input */}
        <View style={styles.header}>
          <View style={[styles.searchContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <Ionicons name="search" size={24} color={theme.colors.textSecondary} />
            <TextInput
              style={[styles.searchInput, { color: theme.colors.text }]}
              placeholder="What do you want to play?"
              placeholderTextColor={theme.colors.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={handleClearSearch}>
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={theme.colors.textSecondary}
                />
              </Pressable>
            )}
          </View>
        </View>

        {/* Category Tabs */}
        {searchQuery.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.categoryTabs}
            contentContainerStyle={styles.categoryTabsContent}
          >
            {categories.map((category) => (
              <Pressable
                key={category.value}
                onPress={() => handleCategoryChange(category.value)}
                style={[
                  styles.categoryTab,
                  activeCategory === category.value && {
                    backgroundColor: theme.colors.primary + '20',
                    borderColor: theme.colors.primary,
                  },
                  !(activeCategory === category.value) && {
                    borderColor: 'transparent',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.categoryTabText,
                    {
                      color: activeCategory === category.value
                        ? theme.colors.primary
                        : theme.colors.text,
                    },
                  ]}
                >
                  {category.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* Loading State - Only show when searching */}
        {searchLoading && hasQuery && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        )}

        {/* Explore/Discovery View - No Query */}
        {searchQuery.length === 0 && (
          <View style={styles.exploreView}>
            {/* Browse All - Genre Cards */}
            <ExploreSection
              title="Browse All"
              isLoading={genresLoading}
              isEmpty={genres.length === 0}
              emptyMessage="No genres available"
            >
              <View style={styles.genreGrid}>
                {genres.map((genre) => (
                  <View key={genre.name} style={styles.genreGridItem}>
                    <GenreCard
                      name={genre.name}
                      color={genre.color}
                      coverArt={genre.coverArt || undefined}
                      onPress={() => handleGenreClick(genre.name)}
                    />
                  </View>
                ))}
              </View>
            </ExploreSection>

            {/* Made for You */}
            <ExploreSection
              title="Made for You"
              isLoading={madeForYouLoading}
              isEmpty={madeForYouAlbums.length === 0 && madeForYouPlaylists.length === 0}
              emptyMessage="No recommendations available"
            >
              <View style={styles.grid}>
                {madeForYouAlbums.map((album) => (
                  <View key={album.id} style={styles.gridItem}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      onPress={() => router.push(`/album/${album.id}`)}
                    />
                  </View>
                ))}
                {madeForYouPlaylists.map((playlist) => (
                  <View key={playlist.id} style={styles.gridItem}>
                    <MediaCard
                      title={playlist.name}
                      subtitle={`Playlist • ${playlist.trackCount || 0} songs`}
                      type="playlist"
                      imageUri={playlist.coverArt}
                      onPress={() => router.push(`/playlist/${playlist.id}` as any)}
                    />
                  </View>
                ))}
              </View>
            </ExploreSection>

            {/* Popular Tracks */}
            <ExploreSection
              title="Popular Tracks"
              isLoading={popularTracksLoading}
              isEmpty={popularTracks.length === 0}
              emptyMessage="No tracks available"
            >
              <View style={styles.grid}>
                {popularTracks.map((track) => (
                  <View key={track.id} style={styles.gridItem}>
                    <MediaCard
                      title={track.title}
                      subtitle={track.artistName}
                      type="track"
                      imageUri={track.coverArt}
                      onPress={() => handleTrackRowPress(track)}
                      onPlayPress={() => handleTrackPress(track)}
                    />
                  </View>
                ))}
              </View>
            </ExploreSection>

            {/* Top Albums */}
            <ExploreSection
              title="Top Albums"
              isLoading={popularAlbumsLoading}
              isEmpty={popularAlbums.length === 0}
              emptyMessage="No albums available"
            >
              <View style={styles.grid}>
                {popularAlbums.map((album) => (
                  <View key={album.id} style={styles.gridItem}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      onPress={() => router.push(`/album/${album.id}`)}
                    />
                  </View>
                ))}
              </View>
            </ExploreSection>

            {/* Top Artists */}
            <ExploreSection
              title="Top Artists"
              isLoading={popularArtistsLoading}
              isEmpty={popularArtists.length === 0}
              emptyMessage="No artists available"
            >
              <View style={styles.grid}>
                {popularArtists.map((artist) => (
                  <View key={artist.id} style={styles.gridItem}>
                    <MediaCard
                      title={artist.name}
                      subtitle="Artist"
                      type="artist"
                      shape="circle"
                      imageUri={artist.image}
                      onPress={() => router.push(`/artist/${artist.id}` as any)}
                    />
                  </View>
                ))}
              </View>
            </ExploreSection>

            {/* Charts */}
            <ExploreSection
              title="Charts"
              isLoading={chartsLoading}
              isEmpty={chartsTracks.length === 0}
              emptyMessage="No charts available"
            >
              <View style={styles.trackList}>
                {chartsTracks.map((track, index) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={index}
                    isCurrentTrack={currentTrack?.id === track.id}
                    isTrackPlaying={currentTrack?.id === track.id && isPlaying}
                    onPress={() => handleTrackRowPress(track)}
                    onPlayPress={() => handleTrackPress(track)}
                  />
                ))}
              </View>
            </ExploreSection>
          </View>
        )}

        {/* Results */}
        {!searchLoading && showResults && searchResults && (
          <View style={styles.results}>
            {/* Tracks Section */}
            {(activeCategory === SearchCategory.ALL || activeCategory === SearchCategory.TRACKS) &&
              searchResults.results.tracks &&
              searchResults.results.tracks.length > 0 && (
                <ExploreSection
                  title={`Tracks (${searchResults.counts.tracks})`}
                  isLoading={false}
                  isEmpty={false}
                >
                  <View style={styles.trackList}>
                    {searchResults.results.tracks.map((track, index) => (
                      <TrackRow
                        key={track.id}
                        track={track}
                        index={index}
                        isCurrentTrack={currentTrack?.id === track.id}
                        isTrackPlaying={currentTrack?.id === track.id && isPlaying}
                        onPress={() => handleTrackRowPress(track)}
                        onPlayPress={() => handleTrackPress(track)}
                      />
                    ))}
                  </View>
                </ExploreSection>
              )}

            {/* Albums Section */}
            {(activeCategory === SearchCategory.ALL || activeCategory === SearchCategory.ALBUMS) &&
              searchResults.results.albums &&
              searchResults.results.albums.length > 0 && (
                <ExploreSection
                  title={`Albums (${searchResults.counts.albums})`}
                  isLoading={false}
                  isEmpty={false}
                >
                  <View style={styles.grid}>
                    {searchResults.results.albums.map((album) => (
                      <View key={album.id} style={styles.gridItem}>
                        <MediaCard
                          title={album.title}
                          subtitle={album.artistName}
                          type="album"
                          imageUri={album.coverArt}
                          onPress={() => router.push(`/album/${album.id}`)}
                        />
                      </View>
                    ))}
                  </View>
                </ExploreSection>
              )}

            {/* Artists Section */}
            {(activeCategory === SearchCategory.ALL || activeCategory === SearchCategory.ARTISTS) &&
              searchResults.results.artists &&
              searchResults.results.artists.length > 0 && (
                <ExploreSection
                  title={`Artists (${searchResults.counts.artists})`}
                  isLoading={false}
                  isEmpty={false}
                >
                  <View style={styles.grid}>
                    {searchResults.results.artists.map((artist) => (
                      <View key={artist.id} style={styles.gridItem}>
                        <MediaCard
                          title={artist.name}
                          subtitle="Artist"
                          type="artist"
                          shape="circle"
                          imageUri={artist.image}
                          onPress={() => router.push(`/artist/${artist.id}` as any)}
                        />
                      </View>
                    ))}
                  </View>
                </ExploreSection>
              )}

            {/* Playlists Section */}
            {(activeCategory === SearchCategory.ALL || activeCategory === SearchCategory.PLAYLISTS) &&
              searchResults.results.playlists &&
              searchResults.results.playlists.length > 0 && (
                <ExploreSection
                  title={`Playlists (${searchResults.counts.playlists})`}
                  isLoading={false}
                  isEmpty={false}
                >
                  <View style={styles.grid}>
                    {searchResults.results.playlists.map((playlist) => (
                      <View key={playlist.id} style={styles.gridItem}>
                        <MediaCard
                          title={playlist.name}
                          subtitle={`Playlist • ${playlist.trackCount || 0} songs`}
                          type="playlist"
                          imageUri={playlist.coverArt}
                          onPress={() => router.push(`/playlist/${playlist.id}` as any)}
                        />
                      </View>
                    ))}
                  </View>
                </ExploreSection>
              )}

            {/* No Results */}
            {!hasResults && (
              <View style={styles.noResultsContainer}>
                <Text style={[styles.noResultsText, { color: theme.colors.textSecondary }]}>
                  No results found for "{debouncedQuery}"
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 100, // Space for bottom player bar
  },
  header: {
    padding: 18,
    paddingBottom: 12,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 4,
    ...Platform.select({
      web: {
        maxWidth: 500,
      },
    }),
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    padding: 0,
  },
  categoryTabs: {
    maxHeight: 50,
    marginBottom: 12,
  },
  categoryTabsContent: {
    paddingHorizontal: 18,
    gap: 8,
  },
  categoryTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    alignItems: 'center',
  },
  categoryTabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    padding: 48,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
  },
  exploreView: {
    paddingHorizontal: 18,
  },
  genreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -6,
  },
  genreGridItem: {
    paddingHorizontal: 6,
    paddingBottom: 12,
    ...Platform.select({
      web: {
        width: '25%', // 4 columns on desktop
        minWidth: 160,
        maxWidth: 240,
      },
      default: {
        width: '50%', // 2 columns on mobile
      },
    }),
  },
  results: {
    paddingHorizontal: 18,
  },
  trackList: {
    gap: 4,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
  },
  gridItem: {
    paddingHorizontal: 4,
    paddingBottom: 16,
    ...Platform.select({
      web: {
        width: '20%', // 5 columns on desktop
        minWidth: 180,
        maxWidth: 220,
      },
      default: {
        width: '50%', // 2 columns on mobile
      },
    }),
  },
  noResultsContainer: {
    padding: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noResultsText: {
    fontSize: 16,
    textAlign: 'center',
  },
});

export default SearchScreen;
