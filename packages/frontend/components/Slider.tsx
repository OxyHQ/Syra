import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from 'react-native-reanimated';
import { useTheme } from '@oxyhq/bloom/theme';

const THUMB_SIZE = 20;
const THUMB_RADIUS = THUMB_SIZE / 2;
const TRACK_HEIGHT = 4;
const TRACK_TOP = 18;
const THUMB_TOP = 10;

const clamp = (value: number, min: number, max: number) => (
  Math.min(max, Math.max(min, value))
);

const getFiniteValue = (value: number, fallback: number) => (
  Number.isFinite(value) ? value : fallback
);

interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  minimumValue?: number;
  maximumValue?: number;
  step?: number;
  label?: string;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  showValue?: boolean;
}

export const Slider: React.FC<SliderProps> = ({
  value,
  onValueChange,
  minimumValue = 0,
  maximumValue = 1,
  step = 0.01,
  label,
  formatValue,
  disabled = false,
  showValue = true,
}) => {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthSV = useSharedValue(0);
  const translateX = useSharedValue(0);
  const isDragging = useSharedValue(false);

  // Update position when value changes externally
  useEffect(() => {
    if (!isDragging.value && width > 0) {
      const safeMin = getFiniteValue(minimumValue, 0);
      const safeMax = getFiniteValue(maximumValue, 1);
      const range = safeMax - safeMin;
      const safeValue = clamp(getFiniteValue(value, safeMin), safeMin, safeMax);
      const percentage = range > 0 ? (safeValue - safeMin) / range : 0;
      translateX.value = clamp(percentage * width, 0, width);
    }
  }, [value, width, minimumValue, maximumValue]);

  const gesture = useMemo(() => {
    const safeMin = getFiniteValue(minimumValue, 0);
    const safeMax = getFiniteValue(maximumValue, 1);
    const safeStep = getFiniteValue(step, 0.01);
    const range = safeMax - safeMin;

    const positionToValue = (position: number, trackWidth: number) => {
      'worklet';
      if (trackWidth <= 0 || range <= 0) {
        return safeMin;
      }

      const percentage = position / trackWidth;
      const rawValue = safeMin + percentage * range;
      const steppedValue = safeStep > 0 ? Math.round(rawValue / safeStep) * safeStep : rawValue;
      return Math.min(safeMax, Math.max(safeMin, steppedValue));
    };

    return Gesture.Pan()
      .enabled(!disabled)
      .minDistance(0)
      .onStart((e) => {
        'worklet';
        // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write inside a worklet; the React Compiler rule does not model SharedValue mutation.
        isDragging.value = true;
        if (widthSV.value > 0) {
          const newPos = Math.min(widthSV.value, Math.max(0, e.x));
          // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write inside a worklet; the React Compiler rule does not model SharedValue mutation.
          translateX.value = newPos;

          runOnJS(onValueChange)(positionToValue(newPos, widthSV.value));
        }
      })
      .onUpdate((e) => {
        'worklet';
        if (widthSV.value > 0) {
          const newPos = Math.min(widthSV.value, Math.max(0, e.x));
          // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write inside a worklet; the React Compiler rule does not model SharedValue mutation.
          translateX.value = newPos;

          runOnJS(onValueChange)(positionToValue(newPos, widthSV.value));
        }
      })
      .onEnd(() => {
        'worklet';
        // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write inside a worklet; the React Compiler rule does not model SharedValue mutation.
        isDragging.value = false;
      });
  }, [disabled, minimumValue, maximumValue, step, onValueChange, widthSV, isDragging, translateX]);

  const thumbStyle = useAnimatedStyle(() => {
    return {
      transform: [{ translateX: translateX.value }],
    };
  });

  const fillStyle = useAnimatedStyle(() => {
    return {
      width: translateX.value,
    };
  });

  const safeValue = clamp(
    getFiniteValue(value, getFiniteValue(minimumValue, 0)),
    getFiniteValue(minimumValue, 0),
    getFiniteValue(maximumValue, 1),
  );
  const displayValue = formatValue ? formatValue(safeValue) : safeValue.toFixed(step < 1 ? 2 : 0);

  return (
    <View style={styles.container}>
      {label && (
        <View style={styles.labelRow}>
          <Text style={[styles.label, { color: theme.colors.text }]}>{label}</Text>
          {showValue && (
            <Text style={[styles.value, { color: theme.colors.primary }]}>{displayValue}</Text>
          )}
        </View>
      )}
      <GestureDetector gesture={gesture}>
        <View
          style={styles.trackContainer}
          onLayout={(e) => {
            const newWidth = Math.max(0, e.nativeEvent.layout.width - THUMB_SIZE);
            setWidth(newWidth);
            // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write; the React Compiler rule does not model SharedValue mutation.
            widthSV.value = newWidth;
          }}
        >
          <View
            style={[
              styles.track,
              { backgroundColor: theme.colors.border },
              disabled && { opacity: 0.5 },
            ]}
          />
          <Animated.View
            style={[
              styles.fill,
              { backgroundColor: theme.colors.primary },
              disabled && { opacity: 0.5 },
              fillStyle,
            ]}
          />
          <Animated.View
            style={[
              styles.thumb,
              {
                backgroundColor: theme.colors.card,
                borderColor: theme.colors.primary,
              },
              disabled && { opacity: 0.5 },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
    minWidth: 0,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  value: {
    fontSize: 14,
    fontWeight: '600',
  },
  trackContainer: {
    height: 40,
    justifyContent: 'center',
    position: 'relative',
    paddingHorizontal: THUMB_RADIUS,
  },
  track: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    alignSelf: 'stretch',
  },
  fill: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    position: 'absolute',
    left: THUMB_RADIUS,
    top: TRACK_TOP,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_RADIUS,
    borderWidth: 2,
    position: 'absolute',
    left: 0,
    top: THUMB_TOP,
    boxShadow: '0px 2px 3px 0px rgba(0, 0, 0, 0.2)',
    elevation: 3,
  },
});
