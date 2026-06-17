import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as Skeleton from '@oxyhq/bloom/skeleton';
import { useTheme } from '@oxyhq/bloom/theme';
import { Repeat } from './Repeat';

/**
 * Loading placeholder for the user profile screen header: a large avatar
 * beside the display name, handle and bio, followed by a stats row.
 * Mirrors `u/[username]` profile header layout.
 */
export const ProfileHeaderSkeleton: React.FC = React.memo(() => {
  const theme = useTheme();

  return (
    <View style={styles.contentContainer}>
      {/* Profile header: avatar + name/handle/bio */}
      <View style={styles.profileHeader}>
        <Skeleton.Circle size={120} />
        <View style={styles.profileInfo}>
          <Skeleton.Box width="60%" height={24} borderRadius={6} />
          <Skeleton.Box width="40%" height={16} borderRadius={4} />
          <Skeleton.Box width="90%" height={14} borderRadius={4} />
        </View>
      </View>

      {/* Stats row */}
      <View style={[styles.statsSection, { borderBottomColor: theme.colors.border }]}>
        <Repeat
          count={3}
          render={() => (
            <View style={styles.statItem}>
              <Skeleton.Box width={40} height={20} borderRadius={4} />
              <Skeleton.Box width={56} height={14} borderRadius={4} />
            </View>
          )}
        />
      </View>
    </View>
  );
});
ProfileHeaderSkeleton.displayName = 'ProfileHeaderSkeleton';

const styles = StyleSheet.create({
  // Mirrors u/[username] `contentContainer`.
  contentContainer: {
    padding: 18,
  },
  // Mirrors u/[username] `profileHeader`.
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 24,
    gap: 20,
  },
  // Mirrors u/[username] `profileInfo`.
  profileInfo: {
    flex: 1,
    gap: 8,
  },
  // Mirrors u/[username] `statsSection`.
  statsSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginBottom: 24,
  },
  // Mirrors u/[username] `statItem`.
  statItem: {
    alignItems: 'center',
    gap: 4,
  },
});
