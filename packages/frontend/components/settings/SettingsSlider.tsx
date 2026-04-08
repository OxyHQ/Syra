import React from 'react';
import { StyleSheet, View, Text, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Slider } from '@/components/Slider';

interface SettingsSliderProps {
  label: string;
  description?: string;
  value: number;
  onValueChange: (value: number) => void;
  minimumValue?: number;
  maximumValue?: number;
  step?: number;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  style?: ViewStyle;
}

/**
 * Settings slider component with label and description
 * Wraps the existing Slider component with settings-specific styling
 */
export const SettingsSlider: React.FC<SettingsSliderProps> = ({
  label,
  description,
  value,
  onValueChange,
  minimumValue = 0,
  maximumValue = 1,
  step = 0.01,
  formatValue,
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
      <View style={styles.header}>
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
      </View>
      <View style={styles.sliderContainer}>
        <Slider
          value={value}
          onValueChange={onValueChange}
          minimumValue={minimumValue}
          maximumValue={maximumValue}
          step={step}
          formatValue={formatValue}
          disabled={disabled}
          showValue={false}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  header: {
    marginBottom: 12,
  },
  leftContent: {
    flex: 1,
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
  sliderContainer: {
    paddingHorizontal: 4,
  },
});






