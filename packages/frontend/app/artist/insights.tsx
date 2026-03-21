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
import { ArtistInsights } from '@syra/shared-types';

/**
 * Artist Insights Screen
 * View analytics and statistics for your music
 */
const ArtistInsightsScreen: React.FC = () => {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [insights, setInsights] = useState<ArtistInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<'7days' | '30days' | 'alltime'>('alltime');

  useEffect(() => {
    loadInsights();
  }, [period]);

  const loadInsights = async () => {
    try {
      setLoading(true);
      const data = await artistService.getArtistInsights(period);
      setInsights(data);
    } catch (error: any) {
      console.error('Failed to load insights:', error);
      if (error?.response?.status === 404) {
        toast.error('You need to register as an artist first');
        router.push('/artist/register');
      } else {
        toast.error(error?.message || 'Failed to load insights');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = () => {
    setRefreshing(true);
    loadInsights();
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

  if (loading && !insights) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  if (!insights) {
    return null;
  }

  return (
    <>
      <SEO title="Artist Insights - Syra" description="View your music analytics and statistics" />
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
            Insights
          </Text>
          <View style={{ width: 24 }} />
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
          {/* Period Selector */}
          <View style={styles.periodSelector}>
            {(['7days', '30days', 'alltime'] as const).map((p) => (
              <Pressable
                key={p}
                onPress={() => setPeriod(p)}
                style={[
                  styles.periodButton,
                  {
                    backgroundColor: period === p ? theme.colors.primary : theme.colors.backgroundSecondary,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.periodButtonText,
                    {
                      color: period === p ? '#FFFFFF' : theme.colors.text,
                      fontWeight: period === p ? 'bold' : 'normal',
                    },
                  ]}
                >
                  {p === '7days' ? '7 Days' : p === '30days' ? '30 Days' : 'All Time'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Stats Overview */}
          <View style={styles.statsGrid}>
            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="play-circle"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(insights.totalPlays)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Total Plays
              </Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="account-multiple"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(insights.monthlyListeners)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Monthly Listeners
              </Text>
            </View>

            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
              <MaterialCommunityIcons
                name="account-heart"
                size={32}
                color={theme.colors.primary}
              />
              <Text style={[styles.statValue, { color: theme.colors.text }]}>
                {formatNumber(insights.followers)}
              </Text>
              <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
                Followers
              </Text>
            </View>
          </View>

          {/* Top Tracks */}
          {insights.topTracks.length > 0 && (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                Top Tracks
              </Text>
              {insights.topTracks.map((track, index) => (
                <View
                  key={track.trackId}
                  style={[styles.trackItem, { borderBottomColor: theme.colors.border }]}
                >
                  <View style={styles.trackRank}>
                    <Text style={[styles.rankNumber, { color: theme.colors.textSecondary }]}>
                      {index + 1}
                    </Text>
                  </View>
                  <View style={styles.trackInfo}>
                    <Text style={[styles.trackTitle, { color: theme.colors.text }]}>
                      {track.title}
                    </Text>
                    <Text style={[styles.trackPlays, { color: theme.colors.textSecondary }]}>
                      {formatNumber(track.playCount)} plays
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => router.push(`/track/${track.trackId}`)}
                    style={styles.trackButton}
                  >
                    <MaterialCommunityIcons
                      name="chevron-right"
                      size={20}
                      color={theme.colors.textSecondary}
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          )}

          {insights.topTracks.length === 0 && (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons
                name="chart-line"
                size={48}
                color={theme.colors.textSecondary}
              />
              <Text style={[styles.emptyStateText, { color: theme.colors.textSecondary }]}>
                No data available yet
              </Text>
              <Text style={[styles.emptyStateSubtext, { color: theme.colors.textSecondary }]}>
                Upload some tracks to see your insights
              </Text>
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
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 24,
  },
  periodSelector: {
    flexDirection: 'row',
    gap: 8,
  },
  periodButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 20,
    alignItems: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  periodButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statCard: {
    flex: 1,
    minWidth: '30%',
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
    fontSize: 12,
    textAlign: 'center',
  },
  section: {
    gap: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  trackItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  trackRank: {
    width: 32,
    alignItems: 'center',
  },
  rankNumber: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  trackInfo: {
    flex: 1,
    gap: 4,
  },
  trackTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  trackPlays: {
    fontSize: 13,
  },
  trackButton: {
    padding: 4,
    ...Platform.select({
      web: {
        cursor: 'pointer',
      },
    }),
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyStateText: {
    fontSize: 16,
    fontWeight: '600',
  },
  emptyStateSubtext: {
    fontSize: 14,
  },
});

export default ArtistInsightsScreen;






