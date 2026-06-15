import React from 'react';
import Svg, { Path, G, Line } from 'react-native-svg';
import { ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';

export const UnpinIcon =({ color: colorProp, size = 24, style }: { color?: string; size?: number; style?: ViewStyle }) => {
  const theme = useTheme();
  const color = colorProp ?? theme.colors.icon;
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size} style={{ ...style }}>
      <G>
        <Path d="M7 4.5C7 3.12 8.12 2 9.5 2h5C15.88 2 17 3.12 17 4.5v5.26L20.12 16H13v5l-1 2-1-2v-5H3.88L7 9.76V4.5z" fill={color} />
        <Line x1="2" y1="22" x2="22" y2="2" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      </G>
    </Svg>
  );
};
