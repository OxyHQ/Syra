import React from 'react';
import { StyleSheet, Pressable, Platform, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';

interface FabProps {
  onPress: () => void;
  iconName: keyof typeof MaterialCommunityIcons.glyphMap;
  accessibilityLabel: string;
  /** Diameter of the circular button. Defaults to 56. */
  size?: number;
  /** Extra positioning/offset styles applied to the absolute container. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Floating Action Button
 * Circular, primary-colored button intended to be anchored to the
 * bottom-right of a scroll container via the `style` prop (absolute position).
 */
export const Fab: React.FC<FabProps> = ({
  onPress,
  iconName,
  accessibilityLabel,
  size = 56,
  style,
}) => {
  const theme = useTheme();
  const iconSize = Math.round(size * 0.46);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.fab,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors.primary,
        },
        style,
      ]}
    >
      <MaterialCommunityIcons
        name={iconName}
        size={iconSize}
        color={theme.colors.primaryForeground}
      />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  fab: {
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: {
        cursor: 'pointer',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
      },
      default: {
        elevation: 6,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
      },
    }),
  },
});
