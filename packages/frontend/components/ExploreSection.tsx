import React from 'react';
import { StyleSheet, View, Text, ActivityIndicator } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface ExploreSectionProps {
  title: string;
  isLoading: boolean;
  isEmpty: boolean;
  emptyMessage?: string;
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
  children,
}) => {
  const theme = useTheme();

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
        {title}
      </Text>
      {isLoading || isEmpty ? (
        <View style={styles.sectionLoading}>
          {isLoading ? (
            <ActivityIndicator size="large" color={theme.colors.primary} />
          ) : (
            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
              {emptyMessage || 'No content available'}
            </Text>
          )}
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






