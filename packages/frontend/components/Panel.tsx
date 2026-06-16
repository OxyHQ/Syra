import React from 'react';
import { StyleSheet, View, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

export interface PanelProps {
  children: React.ReactNode;
  /**
   * Which corners to round
   * - 'top': Top corners only
   * - 'bottom': Bottom corners only
   * - 'left': Left corners only
   * - 'right': Right corners only
   * - 'all': All corners
   * - 'none': No rounded corners
   */
  rounded?: 'top' | 'bottom' | 'left' | 'right' | 'all' | 'none';
  /**
   * Border radius size (default: 12)
   */
  radius?: number;
  /**
   * Background color override
   */
  backgroundColor?: string;
  /**
   * Custom style
   */
  style?: ViewStyle;
  /**
   * Whether to use overflow hidden for rounded corners
   */
  overflow?: boolean;
  /**
   * Disable rounded corners on mobile (default: true)
   */
  disableRoundedOnMobile?: boolean;
}

/**
 * Reusable Panel Component
 * 
 * A flexible panel component with configurable rounded corners,
 * background colors, and positioning. Used throughout the app
 * for consistent panel styling.
 * 
 * @example
 * ```tsx
 * // Top bar with rounded bottom corners
 * <Panel rounded="bottom" radius={12}>
 *   <TopBarContent />
 * </Panel>
 * 
 * // Sidebar with rounded right corners
 * <Panel rounded="right" radius={12}>
 *   <SidebarContent />
 * </Panel>
 * 
 * // Full rounded panel
 * <Panel rounded="all" radius={16}>
 *   <Content />
 * </Panel>
 * ```
 */
export const Panel: React.FC<PanelProps> = ({
  children,
  rounded = 'none',
  radius = 12,
  backgroundColor,
  style,
  overflow = true,
  disableRoundedOnMobile = true,
}) => {
  const theme = useTheme();
  const isScreenNotMobile = useIsScreenNotMobile();
  // A Panel is an elevated content surface, so it defaults to the `surface`
  // token (exposed as `backgroundSecondary`) — distinctly lighter than the
  // app `background` it sits on, so panels read as cards on the gap rather
  // than blending into it. Callers can still override via `backgroundColor`.
  const bgColor = backgroundColor || theme.colors.backgroundSecondary;

  const getBorderRadius = (): Partial<ViewStyle> => {
    // On mobile, disable rounded corners if disableRoundedOnMobile is true
    if (!isScreenNotMobile && disableRoundedOnMobile) {
      return {};
    }

    switch (rounded) {
      case 'top':
        return {
          borderTopLeftRadius: radius,
          borderTopRightRadius: radius,
        };
      case 'bottom':
        return {
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
        };
      case 'left':
        return {
          borderTopLeftRadius: radius,
          borderBottomLeftRadius: radius,
        };
      case 'right':
        return {
          borderTopRightRadius: radius,
          borderBottomRightRadius: radius,
        };
      case 'all':
        return {
          borderRadius: radius,
        };
      case 'none':
      default:
        return {};
    }
  };

  const borderRadius = getBorderRadius();
  const hasRoundedCorners = Object.keys(borderRadius).length > 0;
  const shouldApplyOverflow = overflow && hasRoundedCorners;

  // Build style object safely
  const baseStyle: ViewStyle = {
    backgroundColor: bgColor,
    ...borderRadius,
    ...(shouldApplyOverflow ? { overflow: 'hidden' as const } : {}),
  };

  return (
    <View style={[baseStyle, style]}>
      {children}
    </View>
  );
};
