import React from 'react';
import { StyleSheet, View, Text, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Toggle } from '@/components/Toggle';

interface SettingsToggleProps {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Settings toggle component with label and description
 * Wraps the existing Toggle component with settings-specific styling
 */
export const SettingsToggle: React.FC<SettingsToggleProps> = ({
  label,
  description,
  value,
  onValueChange,
  disabled = false,
  style,
}) => {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.container,
        { borderBottomColor: theme.colors.border },
        style,
      ]}
    >
      <View style={styles.leftContent}>
        <Text style={[styles.label, { color: theme.colors.text }]}>
          {label}
        </Text>
        {description && (
          <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
            {description}
          </Text>
        )}
      </View>
      <Toggle
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        containerStyle={styles.toggleContainer}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  leftContent: {
    flex: 1,
    marginRight: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 4,
  },
  description: {
    fontSize: 14,
    lineHeight: 18,
  },
  toggleContainer: {
    marginRight: 0,
  },
});






