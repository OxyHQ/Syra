import React from 'react';
import { StyleSheet, View, Text, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '@oxyhq/bloom/theme';
import SEO from '@/components/SEO';
import Avatar from '@/components/Avatar';
import { ProfileHeaderSkeleton } from '@/components/skeletons';
import { useProfileData } from '@/hooks/useProfileData';
import { MaterialCommunityIcons } from '@expo/vector-icons';

/**
 * User Profile Screen
 * Displays a user's profile with their music library, playlists, etc.
 */
const UserProfileScreen: React.FC = () => {
  const theme = useTheme();
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profileData, loading } = useProfileData(username);

  if (loading) {
    return (
      <>
        <SEO title={`${username || 'User'} - Syra`} description="User profile" />
        <ScrollView
          style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
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
        <SEO title="User Not Found - Syra" description="User profile not found" />
        <View style={[styles.container, styles.centered, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <MaterialCommunityIcons name="account-off" size={64} color={theme.colors.textSecondary} />
          <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
            User not found
          </Text>
          <Text style={[styles.errorSubtext, { color: theme.colors.textSecondary }]}>
            This user doesn&apos;t exist or the profile is private.
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
        style={[styles.container, { backgroundColor: theme.colors.backgroundSecondary }]}
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
              <Text style={[styles.displayName, { color: theme.colors.text }]}>
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
            <Text style={[styles.username, { color: theme.colors.textSecondary }]}>
              @{profileData.username}
            </Text>
            {profileData.bio && (
              <Text style={[styles.bio, { color: theme.colors.text }]}>
                {profileData.bio}
              </Text>
            )}
          </View>
        </View>

        {/* Stats Section */}
        <View style={[styles.statsSection, { borderBottomColor: theme.colors.border }]}>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: theme.colors.text }]}>
              {profileData.postsCount || 0}
            </Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
              Playlists
            </Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: theme.colors.text }]}>
              {profileData.stats?.followers || 0}
            </Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
              Followers
            </Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: theme.colors.text }]}>
              {profileData.stats?.following || 0}
            </Text>
            <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
              Following
            </Text>
          </View>
        </View>

        {/* Content Section */}
        <View style={styles.contentSection}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            Public Playlists
          </Text>
          <View style={styles.emptyState}>
            <MaterialCommunityIcons 
              name="playlist-music" 
              size={48} 
              color={theme.colors.textSecondary} 
            />
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              No public playlists yet
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





