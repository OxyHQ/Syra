import React, { useState, useMemo, useCallback } from 'react';
import { StyleSheet, View, TextInput, Text, ScrollView, Platform, Pressable } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useOxy } from '@oxyhq/services';
import SEO from '@/components/SEO';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SearchCategory, SearchUser, Track } from '@syra/shared-types';
import { searchService } from '@/services/searchService';
import { searchRefetchInterval } from '@/utils/searchUtils';
import { browseService } from '@/services/browseService';
import { MediaCard } from '@/components/MediaCard';
import { GenreCard } from '@/components/GenreCard';
import Avatar from '@/components/Avatar';
import { ResponsiveGrid } from '@/components/ResponsiveGrid';
import { TrackRow } from '@/components/TrackRow';
import { ExploreSection } from '@/components/ExploreSection';
import { GenreGridSkeleton, MediaCardRowSkeleton, TrackListSkeleton } from '@/components/skeletons';
import { usePlayerStore } from '@/stores/playerStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

/**
 * Syra Search Screen
 * Spotify-like search interface for tracks, albums, artists, and playlists
 */
const SearchScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const { oxyServices } = useOxy();
  const { playTrackList, currentTrack, isPlaying } = usePlayerStore();
  // Seed the search box from a `?q=` deep link (e.g. tapping a #hashtag / @mention).
  const { q } = useLocalSearchParams<{ q?: string }>();
  const [searchQuery, setSearchQuery] = useState(() => (typeof q === 'string' ? q : ''));
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

  // Search query - only enabled when there's a search query.
  // Polls at AUDIUS_REFETCH_MS while the server signals a pending background
  // Audius import and local track results are still sparse; stops automatically
  // once tracks appear or pendingAudiusImport flips false.
  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['search', debouncedQuery, activeCategory],
    queryFn: () => searchService.search(debouncedQuery, {
      category: activeCategory,
      limit: 20,
      offset: 0,
    }),
    enabled: hasQuery,
    staleTime: 1000 * 60 * 5, // 5 minutes
    refetchInterval: (query) => searchRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
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
  const playTrackFromList = useCallback((
    track: Track,
    list: Track[],
    context: { type: 'search' | 'track'; id?: string; name?: string },
  ) => {
    const source = list.length > 0 ? list : [track];
    const index = Math.max(0, source.findIndex((item) => item.id === track.id));
    playTrackList(source, index, context);
  }, [playTrackList]);

  const handleGenrePlay = useCallback(async (genreName: string) => {
    const { tracks } = await browseService.getGenreTracks(genreName, { limit: 50 });
    if (tracks.length > 0) {
      playTrackList(tracks, 0, { type: 'search', id: genreName, name: genreName });
    }
  }, [playTrackList]);

  const handleTrackRowPress = useCallback((track: Track, list: Track[], contextName: string) => {
    if (track.albumId) {
      router.push(`/album/${track.albumId}`);
    } else {
      playTrackFromList(track, list, { type: 'search', name: contextName });
    }
  }, [router, playTrackFromList]);

  const handleGenreClick = useCallback((genreName: string) => {
    setSearchQuery(genreName);
  }, []);

  const handleCategoryChange = useCallback((category: SearchCategory) => {
    setActiveCategory(category);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const getUserAvatarUri = useCallback((avatar?: string) => {
    if (!avatar) return undefined;
    if (avatar.startsWith('http://') || avatar.startsWith('https://')) {
      return avatar;
    }
    return oxyServices.getFileDownloadUrl(avatar, 'thumb');
  }, [oxyServices]);

  const handleUserPress = useCallback((user: SearchUser) => {
    router.push(`/u/${user.username}` as any);
  }, [router]);

  // Memoized categories
  const categories: { value: SearchCategory; label: string }[] = useMemo(() => [
    { value: SearchCategory.ALL, label: 'All' },
    { value: SearchCategory.TRACKS, label: 'Tracks' },
    { value: SearchCategory.ALBUMS, label: 'Albums' },
    { value: SearchCategory.ARTISTS, label: 'Artists' },
    { value: SearchCategory.PLAYLISTS, label: 'Playlists' },
    { value: SearchCategory.USERS, label: 'Users' },
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
          <View style={styles.results}>
            <View style={styles.searchSkeletonSection}>
              <Text style={[styles.searchSkeletonTitle, { color: theme.colors.text }]}>
                Tracks
              </Text>
              <View style={styles.trackList}>
                <TrackListSkeleton count={5} />
              </View>
            </View>
            <View style={styles.searchSkeletonSection}>
              <Text style={[styles.searchSkeletonTitle, { color: theme.colors.text }]}>
                Albums
              </Text>
              <MediaCardRowSkeleton count={5} />
            </View>
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
              loadingSkeleton={<GenreGridSkeleton count={8} />}
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

            {/* Made for You */}
            <ExploreSection
              title="Made for You"
              isLoading={madeForYouLoading}
              isEmpty={madeForYouAlbums.length === 0 && madeForYouPlaylists.length === 0}
              emptyMessage="No recommendations available"
            >
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {madeForYouAlbums.map((album) => (
                  <View key={album.id}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      primaryColor={album.primaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                    />
                  </View>
                ))}
                {madeForYouPlaylists.map((playlist) => (
                  <View key={playlist.id}>
                    <MediaCard
                      title={playlist.name}
                      subtitle={`Playlist • ${playlist.trackCount || 0} songs`}
                      type="playlist"
                      imageUri={playlist.coverArt}
                      primaryColor={playlist.primaryColor}
                      onPress={() => router.push(`/playlist/${playlist.id}` as any)}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </ExploreSection>

            {/* Popular Tracks */}
            <ExploreSection
              title="Popular Tracks"
              isLoading={popularTracksLoading}
              isEmpty={popularTracks.length === 0}
              emptyMessage="No tracks available"
            >
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {popularTracks.map((track) => (
                  <View key={track.id}>
                    <MediaCard
                      title={track.title}
                      subtitle={track.artistName}
                      type="track"
                      imageUri={track.coverArt}
                      images={track.images}
                      primaryColor={track.primaryColor}
                      onPress={() => handleTrackRowPress(track, popularTracks, 'Popular Tracks')}
                      onPlayPress={() => playTrackFromList(track, popularTracks, { type: 'search', name: 'Popular Tracks' })}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </ExploreSection>

            {/* Top Albums */}
            <ExploreSection
              title="Top Albums"
              isLoading={popularAlbumsLoading}
              isEmpty={popularAlbums.length === 0}
              emptyMessage="No albums available"
            >
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {popularAlbums.map((album) => (
                  <View key={album.id}>
                    <MediaCard
                      title={album.title}
                      subtitle={album.artistName}
                      type="album"
                      imageUri={album.coverArt}
                      primaryColor={album.primaryColor}
                      onPress={() => router.push(`/album/${album.id}`)}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
            </ExploreSection>

            {/* Top Artists */}
            <ExploreSection
              title="Top Artists"
              isLoading={popularArtistsLoading}
              isEmpty={popularArtists.length === 0}
              emptyMessage="No artists available"
            >
              <ResponsiveGrid minItemWidth={180} gap={8}>
                {popularArtists.map((artist) => (
                  <View key={artist.id}>
                    <MediaCard
                      title={artist.name}
                      subtitle="Artist"
                      type="artist"
                      shape="circle"
                      imageUri={artist.image}
                      images={artist.images}
                      primaryColor={artist.primaryColor}
                      onPress={() => router.push(`/artist/${artist.id}` as any)}
                    />
                  </View>
                ))}
              </ResponsiveGrid>
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
                    onPress={() => handleTrackRowPress(track, chartsTracks, 'Charts')}
                    onPlayPress={() => playTrackFromList(track, chartsTracks, { type: 'search', name: 'Charts' })}
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
                        onPress={() => handleTrackRowPress(track, searchResults.results.tracks ?? [], debouncedQuery)}
                        onPlayPress={() => playTrackFromList(track, searchResults.results.tracks ?? [], { type: 'search', name: debouncedQuery })}
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
                  <ResponsiveGrid minItemWidth={180} gap={8}>
                    {searchResults.results.albums.map((album) => (
                      <View key={album.id}>
                        <MediaCard
                          title={album.title}
                          subtitle={album.artistName}
                          type="album"
                          imageUri={album.coverArt}
                          primaryColor={album.primaryColor}
                          onPress={() => router.push(`/album/${album.id}`)}
                        />
                      </View>
                    ))}
                  </ResponsiveGrid>
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
                  <ResponsiveGrid minItemWidth={180} gap={8}>
                    {searchResults.results.artists.map((artist) => (
                      <View key={artist.id}>
                        <MediaCard
                          title={artist.name}
                          subtitle="Artist"
                          type="artist"
                          shape="circle"
                          imageUri={artist.image}
                          images={artist.images}
                          primaryColor={artist.primaryColor}
                          onPress={() => router.push(`/artist/${artist.id}` as any)}
                        />
                      </View>
                    ))}
                  </ResponsiveGrid>
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
                  <ResponsiveGrid minItemWidth={180} gap={8}>
                    {searchResults.results.playlists.map((playlist) => (
                      <View key={playlist.id}>
                        <MediaCard
                          title={playlist.name}
                          subtitle={`Playlist • ${playlist.trackCount || 0} songs`}
                          type="playlist"
                          imageUri={playlist.coverArt}
                          primaryColor={playlist.primaryColor}
                          onPress={() => router.push(`/playlist/${playlist.id}` as any)}
                        />
                      </View>
                    ))}
                  </ResponsiveGrid>
                </ExploreSection>
              )}

            {(activeCategory === SearchCategory.ALL || activeCategory === SearchCategory.USERS) &&
              searchResults.results.users &&
              searchResults.results.users.length > 0 && (
                <ExploreSection
                  title={`Users (${searchResults.counts.users})`}
                  isLoading={false}
                  isEmpty={false}
                >
                  <View style={styles.userList}>
                    {searchResults.results.users.map((user) => {
                      const avatarUri = getUserAvatarUri(user.avatar);
                      const followers = typeof user.followers === 'number'
                        ? `${user.followers.toLocaleString()} followers`
                        : 'Profile';

                      return (
                        <Pressable
                          key={user.id}
                          onPress={() => handleUserPress(user)}
                          style={({ pressed }) => [
                            styles.userRow,
                            {
                              backgroundColor: pressed
                                ? theme.colors.backgroundTertiary
                                : theme.colors.backgroundSecondary,
                              borderColor: theme.colors.border,
                            },
                          ]}
                        >
                          <Avatar
                            source={avatarUri}
                            size={48}
                            verified={user.verified}
                            label={user.displayName}
                          />
                          <View style={styles.userInfo}>
                            <Text
                              style={[styles.userName, { color: theme.colors.text }]}
                              numberOfLines={1}
                            >
                              {user.displayName}
                            </Text>
                            <Text
                              style={[styles.userHandle, { color: theme.colors.textSecondary }]}
                              numberOfLines={1}
                            >
                              @{user.username} • {followers}
                            </Text>
                            {user.bio && (
                              <Text
                                style={[styles.userBio, { color: theme.colors.textSecondary }]}
                                numberOfLines={2}
                              >
                                {user.bio}
                              </Text>
                            )}
                          </View>
                          <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                        </Pressable>
                      );
                    })}
                  </View>
                </ExploreSection>
              )}

            {/* No Results */}
            {!hasResults && (
              <View style={styles.noResultsContainer}>
                <Text style={[styles.noResultsText, { color: theme.colors.textSecondary }]}>
                  No results found for &quot;{debouncedQuery}&quot;
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
  // Skeleton section styling mirrors ExploreSection's section/title spacing.
  searchSkeletonSection: {
    marginBottom: 32,
  },
  searchSkeletonTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  exploreView: {
    paddingHorizontal: 18,
  },
  results: {
    paddingHorizontal: 18,
  },
  trackList: {
    gap: 4,
  },
  userList: {
    gap: 8,
  },
  userRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 74,
  },
  userInfo: {
    flex: 1,
    minWidth: 0,
  },
  userName: {
    fontSize: 15,
    fontWeight: '700',
  },
  userHandle: {
    fontSize: 13,
    marginTop: 2,
  },
  userBio: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
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
