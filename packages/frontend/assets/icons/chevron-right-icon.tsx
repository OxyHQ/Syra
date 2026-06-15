import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

export const ChevronRightIcon = ({ color: colorProp, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  const theme = useTheme();
  const color = colorProp ?? theme.colors.icon;
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <Path
        d="M9.29 6.71c-.39.39-.39 1.02 0 1.41L13.17 12l-3.88 3.88c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l4.59-4.59c.39-.39.39-1.02 0-1.41L10.7 6.7c-.38-.38-1.02-.38-1.41.01z"
        fill={color}
      />
    </Svg>
  );
};

