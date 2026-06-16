import React from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MediaCardRowSkeleton } from '@/components/skeletons';

interface ExploreSectionProps {
  title: string;
  isLoading: boolean;
  isEmpty: boolean;
  emptyMessage?: string;
  /**
   * Skeleton rendered while loading, mirroring this section's content. Defaults
   * to a media-card grid; pass a matching skeleton for non-card sections.
   */
  loadingSkeleton?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Reusable Explore Section Component
 * Handles loading, empty, and content states consistently
 */
export const ExploreSection: React.FC<ExploreSectionProps> = ({
  title,
  isLoading,
  isEmpty,
  emptyMessage,
  loadingSkeleton,
  children,
}) => {
  const theme = useTheme();

  if (isLoading) {
    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          {title}
        </Text>
        {loadingSkeleton ?? <MediaCardRowSkeleton count={5} />}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
        {title}
      </Text>
      {isEmpty ? (
        <View style={styles.sectionLoading}>
          <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
            {emptyMessage || 'No content available'}
          </Text>
        </View>
      ) : (
        children
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  sectionLoading: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 100,
  },
  emptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});






