import React, { useMemo } from 'react';
import { StyleSheet, Pressable, Platform, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  Easing,
  interpolate,
  type SharedValue,
} from 'react-native-reanimated';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * `expanded` control accepted by {@link Fab} when used as an extended FAB.
 * Either a Reanimated shared value (1 = expanded pill, 0 = collapsed circle)
 * driven by the parent's scroll, or a plain boolean (animated internally).
 */
type ExpandedControl = SharedValue<number> | boolean;

interface FabProps {
  onPress: () => void;
  iconName: keyof typeof MaterialCommunityIcons.glyphMap;
  accessibilityLabel: string;
  /** Diameter of the circular (collapsed) button. Defaults to 56. */
  size?: number;
  /**
   * Optional label. When provided the FAB renders as a Material-style
   * **extended** pill (icon + label) that can collapse to an icon-only circle.
   */
  label?: string;
  /**
   * Drives the expanded/collapsed state of the extended FAB. Pass a shared
   * value (1 expanded, 0 collapsed) to drive it from a scroll handler with no
   * re-renders, or a boolean to animate internally. Ignored when no `label`.
   * Defaults to expanded.
   */
  expanded?: ExpandedControl;
  /** Extra positioning/offset styles applied to the absolute container. */
  style?: StyleProp<ViewStyle>;
}

const TIMING = { duration: 220, easing: Easing.out(Easing.cubic) };

/** Upper bound (px) for the label wrapper's animated `maxWidth`. Large enough
 *  to never clip a realistic FAB label while keeping `overflow:'hidden'` able
 *  to fully tuck it away as `progress` → 0. */
const LABEL_MAX_WIDTH = 240;

/**
 * Floating Action Button.
 *
 * - Without `label`: a circular, primary-colored icon button (legacy API).
 * - With `label`: a Material extended FAB — an intrinsic-width pill (icon +
 *   label) that collapses to an icon-only circle when `expanded` is driven to
 *   0 and expands back to the full pill at 1. All animation runs on the UI
 *   thread (Reanimated), so toggling `expanded` triggers no React re-renders.
 *
 * Anchor it to a scroll container via the `style` prop (absolute position).
 */
const FabComponent: React.FC<FabProps> = ({
  onPress,
  iconName,
  accessibilityLabel,
  size = 56,
  label,
  expanded,
  style,
}) => {
  const theme = useTheme();
  const iconSize = Math.round(size * 0.46);

  // Size-derived dimensions for the icon-only circular variant.
  const circleDims = useMemo<ViewStyle>(
    () => ({ width: size, height: size, borderRadius: size / 2 }),
    [size]
  );

  // Horizontal padding revealed between the pill edge and its contents when
  // expanded. Collapsed it animates to 0 so the pill shrinks to `size`.
  const horizontalPadding = Math.round(size * 0.28);
  const iconLabelGap = 8;

  // Normalize the `expanded` control into a single 0..1 shared value driving
  // all animation. A boolean animates to its target; a shared value is mirrored
  // (parent owns timing); with neither we stay expanded (constant 1).
  const expandedFlag = typeof expanded === 'boolean' ? expanded : true;
  const sharedExpanded = typeof expanded === 'object' ? expanded : undefined;
  const progress = useDerivedValue(() => {
    if (sharedExpanded) {
      return sharedExpanded.value;
    }
    return withTiming(expandedFlag ? 1 : 0, TIMING);
  }, [expandedFlag, sharedExpanded]);

  // Pill grows intrinsically with its content; we only animate the leading
  // icon centering padding and the trailing edge padding off `progress`.
  const containerAnimatedStyle = useAnimatedStyle(() => ({
    paddingLeft: (size - iconSize) / 2,
    paddingRight: horizontalPadding * progress.value,
  }));

  const labelAnimatedStyle = useAnimatedStyle(() => ({
    // Fade + tuck the label away as the pill collapses. `overflow:'hidden'` on
    // the pill clips the label once `maxWidth` reaches 0.
    opacity: progress.value,
    maxWidth: interpolate(progress.value, [0, 1], [0, LABEL_MAX_WIDTH]),
    marginLeft: iconLabelGap * progress.value,
  }));

  // Icon-only (legacy) circular FAB.
  if (!label) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={[styles.fab, circleDims, { backgroundColor: theme.colors.primary }, style]}
      >
        <MaterialCommunityIcons
          name={iconName}
          size={iconSize}
          color={theme.colors.primaryForeground}
        />
      </Pressable>
    );
  }

  // Extended (collapsible pill) FAB.
  return (
    <AnimatedPressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.fab,
        styles.extended,
        { height: size, borderRadius: size / 2, backgroundColor: theme.colors.primary },
        containerAnimatedStyle,
        style,
      ]}
    >
      <MaterialCommunityIcons
        name={iconName}
        size={iconSize}
        color={theme.colors.primaryForeground}
      />
      <Animated.Text
        numberOfLines={1}
        style={[styles.label, { color: theme.colors.primaryForeground }, labelAnimatedStyle]}
      >
        {label}
      </Animated.Text>
    </AnimatedPressable>
  );
};

export const Fab = React.memo(FabComponent);
Fab.displayName = 'Fab';

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
  extended: {
    flexDirection: 'row',
    overflow: 'hidden',
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
  },
});
