import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  ScrollView,
  Pressable,
  Platform,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { artistService } from '@/services/artistService';
import { toast } from 'sonner';
import SEO from '@/components/SEO';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArtistDashboard } from '@syra/shared-types';

/**
 * Artist Dashboard Screen
 * Overview of artist's music, stats, and quick actions
 */
const ArtistDashboardScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [dashboard, setDashboard] = useState<ArtistDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, []);

  const loadDashboard = async () => {
    try {
      setLoading(true);
      const data = await artistService.getArtistDashboard();
      setDashboard(data);
    } catch (error: any) {
      console.error('Failed to load dashboard:', error);
      if (error?.response?.status === 404) {
        toast.error('You need to register as an artist first');
        router.push('/artist/register');
      } else {
        toast.error(error?.message || 'Failed to load dashboard');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadDashboard();
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    }
    if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  if (loading && !dashboard) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!dashboard) {
    return null;
  }

  return (
    <>
      <SEO title="Artist Dashboard - Syra" description="Manage your music and view your stats" />
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        {/* Header */}
        <View
          style={[
            styles.header,
            {
              backgroundColor: theme.colors.background,
              borderBottomColor: theme.colors.border,
              paddingTop: Math.max(insets.top, 8),
            },
          ]}
        >
          <Pressable
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <MaterialCommunityIcons
              name="arrow-left"
              size={24}
              color={theme.colors.text}
            />
          </Pressable>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Dashboard
          </Text>
          <Pressable
            onPress={() => router.push('/artist/insights')}
            style={styles.insightsButton}
          >
            <MaterialCommunityIcons
              name="chart-line"
              size={24}
              color={theme.colors.primary}
            />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: insets.bottom + 16 },
          ]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
          }
          showsVerticalScrollIndicator={false}
        >
          {/* Strike Warning Banner */}
          {dashboard.strikeCount > 0 && (
            <View style={[styles.warningBanner, { 
              backgroundColor: dashboard.strikeCount >= 3 
                ? theme.colors.error + '20' 
                : theme.colors.warning + '20',
              borderColor: dashboard.strikeCount >= 3 
                ? theme.colors.error 
                : theme.colors.warning,
            }]}>
              <MaterialCommunityIcons
                name={dashboard.strikeCount >= 3 ? "alert-circle" : "alert"}
                size={24}
                color={dashboard.strikeCount >= 3 ? theme.colors.error : theme.colors.warning}
              />
              <View style={styles.warningContent}>
                <Text style={[styles.warningTitle, { 
                  color: dashboard.strikeCount >= 3 ? theme.colors.error : theme.colors.warning 
                }]}>
                  {dashboard.strikeCount >= 3 
                    ? 'Uploads Disabled' 
                    : `Warning: ${dashboard.strikeCount} Copyright Strike${dashboard.strikeCount > 1 ? 's' : ''}`}
                </Text>
                <Text style={[styles.warningText, { color: theme.colors.textSecondary }]}>
                  {dashboard.strikeCount >= 3
                    ? 'Your uploads have been disabled due to multiple copyright violations. Please contact support for assistance.'
                    : `You have ${dashboard.strikeCount} copyright strike${dashboard.strikeCount > 1 ? 's' : ''}. ${dashboard.strikeCount === 2 ? 'One more strike will disable your uploads.' : 'Please ensure all content is original or properly licensed.'}`}
                </Text>
              </View>
            </View>
          )}

          {/* Upload Disabled Banner */}
          {dashboard.uploadsDisabled && (
            <View style={[styles.errorBanner, { 
              backgroundColor: theme.colors.error + '20',
              borderColor: theme.colors.error,
            }]}>
              <MaterialCommunityIcons
                name="upload-off"
                size={24}
                color={theme.colors.error}
              />
              <View style={styles.warningContent}>
                <Text style={[styles.warningTitle, { color: theme.colors.error }]}>
                  Uploads Disabled
                </Text>
                <Text style={[styles.warningText, { color: theme.colors.textSecondary }]}>
                  You cannot upload new tracks or albums due to copyright strikes. Please contact support to resolve this issue.
                </Text>
              </View>
            </View>
          )}

          {/* Stats Cards */}
          <View style={styles.statsGrid}>
            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="music"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(dashboard.totalTracks)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Tracks
              </Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="album"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(dashboard.totalAlbums)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Albums
              </Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="play-circle"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(dashboard.totalPlays)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Plays
              </Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="account-heart"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(dashboard.followers)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Followers
              </Text>
            </View>
          </View>

          {/* Quick Actions */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              Quick Actions
            </Text>
            <View style={styles.actionsGrid}>
              <Pressable
                onPress={() => router.push('/artist/upload?tab=song')}
                disabled={dashboard.uploadsDisabled}
                style={[
                  styles.actionButton, 
                  { 
                    backgroundColor: dashboard.uploadsDisabled 
                      ? theme.colors.textSecondary 
                      : theme.colors.primary,
                    opacity: dashboard.uploadsDisabled ? 0.6 : 1,
                  }
                ]}
              >
                <MaterialCommunityIcons name="upload" size={24} color="#FFFFFF" />
                <Text style={styles.actionButtonText}>Upload Song</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/artist/upload?tab=album')}
                disabled={dashboard.uploadsDisabled}
                style={[
                  styles.actionButton, 
                  { 
                    backgroundColor: dashboard.uploadsDisabled 
                      ? theme.colors.textSecondary 
                      : theme.colors.primary,
                    opacity: dashboard.uploadsDisabled ? 0.6 : 1,
                  }
                ]}
              >
                <MaterialCommunityIcons name="album" size={24} color="#FFFFFF" />
                <Text style={styles.actionButtonText}>Create Album</Text>
              </Pressable>
            </View>
          </View>

          {/* Copyright Removed Tracks */}
          {dashboard.copyrightRemovedTracks.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Copyright Removed Tracks
              </Text>
              <View style={[styles.removedTracksContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {dashboard.copyrightRemovedTracks.map((track) => (
                  <View
                    key={track.id}
                    style={[styles.removedTrackItem, { borderBottomColor: theme.colors.border }]}
                  >
                    <MaterialCommunityIcons
                      name="copyright"
                      size={20}
                      color={theme.colors.error}
                    />
                    <View style={styles.removedTrackInfo}>
                      <Text style={[styles.removedTrackTitle, { color: theme.colors.text }]}>
                        {track.title}
                      </Text>
                      <Text style={[styles.removedTrackMeta, { color: theme.colors.textSecondary }]}>
                        Removed: {new Date(track.removedAt).toLocaleDateString()}
                        {track.removedReason && ` • ${track.removedReason}`}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}

          {/* Recent Tracks */}
          {dashboard.recentTracks.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                  Recent Tracks
                </Text>
                <Pressable onPress={() => router.push(`/artist/${dashboard.artist.id}`)}>
                  <Text style={[styles.seeAll, { color: theme.colors.primary }]}>
                    See All
                  </Text>
                </Pressable>
              </View>
              {dashboard.recentTracks.map((track) => (
                <Pressable
                  key={track.id}
                  onPress={() => router.push(`/track/${track.id}`)}
                  style={[styles.trackItem, { borderBottomColor: theme.colors.border }]}
                >
                  <View style={styles.trackInfo}>
                    <Text style={[styles.trackTitle, { color: theme.colors.text }]}>
                      {track.title}
                    </Text>
                    <Text style={[styles.trackMeta, { color: theme.colors.textSecondary }]}>
                      {formatNumber(track.playCount)} plays
                    </Text>
                  </View>
                  <MaterialCommunityIcons
                    name="chevron-right"
                    size={20}
                    color={theme.colors.textSecondary}
                  />
                </Pressable>
              ))}
            </View>
          )}

          {/* Recent Albums */}
          {dashboard.recentAlbums.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                  Recent Albums
                </Text>
                <Pressable onPress={() => router.push(`/artist/${dashboard.artist.id}`)}>
                  <Text style={[styles.seeAll, { color: theme.colors.primary }]}>
                    See All
                  </Text>
                </Pressable>
              </View>
              {dashboard.recentAlbums.map((album) => (
                <Pressable
                  key={album.id}
                  onPress={() => router.push(`/album/${album.id}`)}
                  style={[styles.albumItem, { borderBottomColor: theme.colors.border }]}
                >
                  <View style={styles.albumInfo}>
                    <Text style={[styles.albumTitle, { color: theme.colors.text }]}>
                      {album.title}
                    </Text>
                    <Text style={[styles.albumMeta, { color: theme.colors.textSecondary }]}>
                      {album.totalTracks} tracks
                    </Text>
                  </View>
                  <MaterialCommunityIcons
                    name="chevron-right"
                    size={20}
                    color={theme.colors.textSecondary}
                  />
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  backButton: {
    padding: 6,
    borderRadius: 24,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  title: {
    flex: 1,
    fontSize: 18,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  insightsButton: {
    padding: 6,
    borderRadius: 24,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 24,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    flex: 1,
    minWidth: '45%',
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
    gap: 8,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  statLabel: {
    fontSize: 13,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  seeAll: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionsGrid: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 16,
    borderRadius: 16,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  actionButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  trackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  trackInfo: {
    flex: 1,
    gap: 4,
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  trackMeta: {
    fontSize: 13,
  },
  albumItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  albumInfo: {
    flex: 1,
    gap: 4,
  },
  albumTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  albumMeta: {
    fontSize: 13,
  },
  warningBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  warningContent: {
    flex: 1,
    gap: 4,
  },
  warningTitle: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  warningText: {
    fontSize: 14,
    lineHeight: 20,
  },
  removedTracksContainer: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  removedTrackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  removedTrackInfo: {
    flex: 1,
    gap: 4,
  },
  removedTrackTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  removedTrackMeta: {
    fontSize: 12,
  },
});

export default ArtistDashboardScreen;

