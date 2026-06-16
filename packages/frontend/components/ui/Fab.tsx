import React, { useMemo } from 'react';
import {
  StyleSheet,
  Pressable,
  Platform,
  StyleProp,
  ViewStyle,
  Text,
  LayoutChangeEvent,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
  Easing,
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

/**
 * Floating Action Button.
 *
 * - Without `label`: a circular, primary-colored icon button (legacy API).
 * - With `label`: a Material extended FAB — an animated pill (icon + label)
 *   that collapses to an icon-only circle when `expanded` is driven to 0 and
 *   expands back to the full pill at 1. All animation runs on the UI thread
 *   (Reanimated), so toggling `expanded` triggers no React re-renders.
 *
 * Anchor it to a scroll container via the `style` prop (absolute position).
 */
export const Fab: React.FC<FabProps> = ({
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

  // Measured intrinsic width of the label text, captured via onLayout so the
  // pill can size itself precisely (no mid-animation clipping).
  const labelWidth = useSharedValue(0);

  // Normalize the `expanded` control into a single 0..1 shared value. When a
  // boolean is passed we animate to its target; when a shared value is passed
  // we mirror it; with neither we stay expanded.
  const internalProgress = useSharedValue(typeof expanded === 'boolean' && !expanded ? 0 : 1);
  const progress = useDerivedValue(() => {
    if (typeof expanded === 'boolean') {
      return withTiming(expanded ? 1 : 0, TIMING);
    }
    if (expanded) {
      // Shared value: parent is responsible for the timing/animation.
      return expanded.value;
    }
    return internalProgress.value;
  }, [expanded]);

  // Horizontal padding between the icon and the pill edges when expanded.
  const horizontalPadding = Math.round(size * 0.28);
  const iconLabelGap = 8;

  const onLabelLayout = (e: LayoutChangeEvent) => {
    labelWidth.value = e.nativeEvent.layout.width;
  };

  const containerAnimatedStyle = useAnimatedStyle(() => {
    // Collapsed: a perfect circle of `size`. Expanded: size + gap + label +
    // trailing padding. The leading padding matches the circle's icon centering.
    const expandedWidth = size + iconLabelGap + labelWidth.value + horizontalPadding;
    return {
      width: size + (expandedWidth - size) * progress.value,
    };
  });

  const labelAnimatedStyle = useAnimatedStyle(() => {
    return {
      // Fade the label out faster than the container shrinks so text never
      // shows against a too-narrow pill.
      opacity: progress.value,
      maxWidth: labelWidth.value * progress.value,
      marginLeft: iconLabelGap * progress.value,
    };
  });

  const containerColorStyle = useMemo<ViewStyle>(
    () => ({ backgroundColor: theme.colors.primary }),
    [theme.colors.primary]
  );

  // Icon-only (legacy) circular FAB.
  if (!label) {
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
          },
          containerColorStyle,
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
        {
          height: size,
          borderRadius: size / 2,
          paddingLeft: (size - iconSize) / 2,
          paddingRight: horizontalPadding,
        },
        containerColorStyle,
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
      {/* Off-screen measurement of the label's intrinsic width. */}
      <Text
        aria-hidden
        pointerEvents="none"
        onLayout={onLabelLayout}
        style={styles.measure}
      >
        {label}
      </Text>
    </AnimatedPressable>
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
  extended: {
    flexDirection: 'row',
    overflow: 'hidden',
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
  },
  measure: {
    position: 'absolute',
    opacity: 0,
    left: -9999,
    top: -9999,
    fontSize: 15,
    fontWeight: '700',
  },
});
