import React from 'react';
import Svg, { Path, G } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

export const CloseIcon = ({ color: colorProp, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  const theme = useTheme();
  const color = colorProp ?? theme.colors.icon;
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <G>
        <Path fill={color} d="M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"></Path>
      </G>
    </Svg>
  );
};
