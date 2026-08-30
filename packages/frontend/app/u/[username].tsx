import React from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { ProfileHeaderSkeleton } from '@/components/skeletons';
import { useProfileData } from '@/hooks/useProfileData';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';

/**
 * User Profile Screen
 * Displays a user's profile with their music library, playlists, etc.
 */
const UserProfileScreen: React.FC = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profileData, loading } = useProfileData(username);

  if (loading) {
    return (
      <>
        <SEO title={`${username || 'User'} - Syra`} description={t('user.seo.description')} />
        <ScrollView
          className="bg-surface" style={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <ProfileHeaderSkeleton />
        </ScrollView>
      </>
    );
  }

  if (!profileData) {
    return (
      <>
        <SEO title={t('user.seo.notFoundTitle')} description={t('user.seo.notFoundDescription')} />
        <View className="bg-surface" style={[styles.container, styles.centered]}>
          <MaterialCommunityIcons name="account-off" size={64} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground" style={styles.errorText}>
            {t('user.notFound')}
          </Text>
          <Text className="text-muted-foreground" style={styles.errorSubtext}>
            {t('user.notFoundMessage')}
          </Text>
        </View>
      </>
    );
  }

  // `design.displayName` already resolves the user customization override first,
  // then the canonical API `name.displayName`, then username (see computeDesign).
  const displayName = profileData.design?.displayName || profileData.username || 'User';

  return (
    <>
      <SEO 
        title={`${displayName} (@${profileData.username}) - Syra`} 
        description={profileData.bio || `Profile page for ${displayName}`} 
      />
      <ScrollView
        className="bg-surface" style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <Avatar
            source={profileData.avatar ?? undefined}
            variant="thumb"
            size={120}
            verified={profileData.verified}
          />
          <View style={styles.profileInfo}>
            <View style={styles.nameRow}>
              <Text className="text-foreground" style={styles.displayName}>
                {displayName}
              </Text>
              {profileData.verified && (
                <MaterialCommunityIcons 
                  name="check-circle" 
                  size={24} 
                  color={theme.colors.primary} 
                  style={styles.verifiedBadge}
                />
              )}
            </View>
            <Text className="text-muted-foreground" style={styles.username}>
              @{profileData.username}
            </Text>
            {profileData.bio && (
              <Text className="text-foreground" style={styles.bio}>
                {profileData.bio}
              </Text>
            )}
          </View>
        </View>

        {/* Stats Section */}
        <View style={[styles.statsSection, { borderBottomColor: theme.colors.border }]}>
          <View style={styles.statItem}>
            <Text className="text-foreground" style={styles.statValue}>
              {profileData.postsCount || 0}
            </Text>
            <Text className="text-muted-foreground" style={styles.statLabel}>
              {t('common.playlists')}
            </Text>
          </View>
          <View style={styles.statItem}>
            <Text className="text-foreground" style={styles.statValue}>
              {profileData.stats?.followers || 0}
            </Text>
            <Text className="text-muted-foreground" style={styles.statLabel}>
              {t('common.followers')}
            </Text>
          </View>
          <View style={styles.statItem}>
            <Text className="text-foreground" style={styles.statValue}>
              {profileData.stats?.following || 0}
            </Text>
            <Text className="text-muted-foreground" style={styles.statLabel}>
              {t('common.following')}
            </Text>
          </View>
        </View>

        {/* Content Section */}
        <View style={styles.contentSection}>
          <Text className="text-foreground" style={styles.sectionTitle}>
            {t('user.publicPlaylists')}
          </Text>
          <View style={styles.emptyState}>
            <MaterialCommunityIcons 
              name="playlist-music" 
              size={48} 
              color={theme.colors.textSecondary} 
            />
            <Text className="text-muted-foreground" style={styles.emptyText}>
              {t('user.noPublicPlaylists')}
            </Text>
          </View>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>
    </>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  contentContainer: {
    padding: 18,
    paddingBottom: 100,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 24,
    gap: 20,
  },
  profileInfo: {
    flex: 1,
    gap: 8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  displayName: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  verifiedBadge: {
    marginTop: 2,
  },
  username: {
    fontSize: 16,
    fontWeight: '500',
  },
  bio: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  statsSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
  },
  statItem: {
    alignItems: 'center',
    gap: 4,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  statLabel: {
    fontSize: 14,
  },
  contentSection: {
    marginTop: 8,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
  },
  errorText: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 16,
  },
  errorSubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    paddingHorizontal: 32,
  },
});

export default UserProfileScreen;





