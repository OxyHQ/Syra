import React from 'react';
import { StyleSheet, View, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { MediaCardRowSkeleton } from '@/components/skeletons';
import { EmptyState } from '@/components/common/EmptyState';

interface ExploreSectionProps {
  title: string;
  isLoading: boolean;
  isEmpty: boolean;
  /**
   * Query error for this section. When set, the section renders a retry state
   * instead of the empty message — a failed request must never read as an
   * empty catalog.
   */
  error?: Error | null;
  /** Re-runs the section's query. A React Query `refetch` can be passed directly. */
  onRetry?: () => Promise<unknown>;
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
 * Handles loading, error, empty, and content states consistently
 */
export const ExploreSection: React.FC<ExploreSectionProps> = ({
  title,
  isLoading,
  isEmpty,
  error,
  onRetry,
  emptyMessage,
  loadingSkeleton,
  children,
}) => {
  const { t } = useTranslation();
  const theme = useTheme();

  // The error branch wins over `isLoading`: while a failed query refetches,
  // EmptyState shows its own retry spinner rather than flashing back to the
  // skeleton, so the user keeps the context of what failed.
  if (error) {
    return (
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          {title}
        </Text>
        <EmptyState
          icon={{ name: 'alert-circle-outline' }}
          error={{
            title: t('explore.errorTitle'),
            message: t('explore.errorMessage'),
            onRetry: onRetry ? async () => { await onRetry(); } : undefined,
          }}
          containerStyle={styles.stateContainer}
        />
      </View>
    );
  }

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
        <EmptyState
          subtitle={emptyMessage || 'No content available'}
          accessibilityLabel={emptyMessage || 'No content available'}
          containerStyle={styles.stateContainer}
        />
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
  // EmptyState defaults to a full-height, app-background block; inside a section
  // it must size to its content and let the screen background show through.
  stateContainer: {
    flex: 0,
    minHeight: 100,
    backgroundColor: 'transparent',
  },
});
