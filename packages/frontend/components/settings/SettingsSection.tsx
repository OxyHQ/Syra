import React from 'react';
import { StyleSheet, View, Text, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface SettingsSectionProps {
  title?: string;
  children: React.ReactNode;
  style?: ViewStyle;
}

/**
 * Container component for a settings section
 * Provides consistent spacing and optional title
 */
export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  children,
  style,
}) => {
  const theme = useTheme();

  return (
    <View style={[styles.container, style]}>
      {title && (
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {title}
        </Text>
      )}
      <View style={[styles.content, { backgroundColor: theme.colors.backgroundSecondary }]}>
        {children}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 24,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 12,
    paddingHorizontal: 18,
  },
  content: {
    borderRadius: 8,
    overflow: 'hidden',
  },
});






