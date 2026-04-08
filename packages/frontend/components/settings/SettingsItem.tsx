import React from 'react';
import { StyleSheet, View, Text, Pressable, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Ionicons } from '@expo/vector-icons';

interface SettingsItemProps {
  label: string;
  description?: string;
  onPress?: () => void;
  rightElement?: React.ReactNode;
  showChevron?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Individual settings row component
 * Can be clickable (with onPress) or static (with rightElement)
 */
export const SettingsItem: React.FC<SettingsItemProps> = ({
  label,
  description,
  onPress,
  rightElement,
  showChevron = false,
  disabled = false,
  style,
}) => {
  const theme = useTheme();
  const isPressable = !!onPress && !disabled;

  const content = (
    <View
      style={[
        styles.container,
        isPressable && styles.pressable,
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
      <View style={styles.rightContent}>
        {rightElement}
        {showChevron && (
          <Ionicons
            name="chevron-forward"
            size={20}
            color={theme.colors.textSecondary}
            style={styles.chevron}
          />
        )}
      </View>
    </View>
  );

  if (isPressable) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        style={({ pressed }) => [
          pressed && { opacity: 0.7 },
        ]}
      >
        {content}
      </Pressable>
    );
  }

  return content;
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
  pressable: {
    // Additional styles for pressable items if needed
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
  rightContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  chevron: {
    marginLeft: 4,
  },
});






