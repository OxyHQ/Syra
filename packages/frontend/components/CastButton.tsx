import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useCast } from '@/hooks/useCast';
import { createScopedLogger } from '@/utils/logger';

const logger = createScopedLogger('CastButton');

interface CastButtonProps {
  /** Glyph size in px. Defaults to 20 to match the player control row. */
  size?: number;
  /**
   * Idle glyph color. Defaults to the theme's secondary text color. When set,
   * the casting (active) state keeps the same color and relies on the filled
   * `cast-connected` glyph to signal the connection — this keeps the button
   * readable on bars whose controls aren't tinted with the theme accent.
   */
  color?: string;
}

/**
 * Cast button for the player transport rows.
 *
 * Reads cast capability/state from {@link useCast}. Renders nothing when the
 * platform/build cannot cast, so it can be dropped into any control row without
 * leaving a dead control behind. Follows PlayerBar's StyleSheet + theme.colors
 * idiom (no NativeWind) to match the surrounding controls.
 */
export const CastButton: React.FC<CastButtonProps> = ({ size = 20, color }) => {
  const theme = useTheme();
  const { isSupported, isCasting, deviceName, requestSession, endSession } = useCast();

  if (!isSupported) {
    return null;
  }

  const handlePress = async () => {
    try {
      if (isCasting) {
        await endSession();
      } else {
        await requestSession();
      }
    } catch (error) {
      logger.error(isCasting ? 'Failed to end cast session' : 'Failed to start cast session', error);
    }
  };

  const idleTint = color ?? theme.colors.textSecondary;
  const activeTint = color ?? theme.colors.primary;

  return (
    <Pressable
      style={styles.button}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={{ selected: isCasting }}
      accessibilityLabel={
        isCasting
          ? deviceName
            ? `Stop casting to ${deviceName}`
            : 'Stop casting'
          : 'Cast to a device'
      }
    >
      <MaterialCommunityIcons
        name={isCasting ? 'cast-connected' : 'cast'}
        size={size}
        color={isCasting ? activeTint : idleTint}
      />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
