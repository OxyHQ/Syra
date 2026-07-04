import React from 'react';
import Svg, { Rect } from 'react-native-svg';
import { ViewStyle, type ColorValue } from 'react-native';

export const SyraIcon = ({ color = 'currentColor', size = 26, style }: { color?: ColorValue; size?: number; style?: ViewStyle }) => (
  <Svg viewBox="0 0 500 500" width={size} height={size} style={style}>
    <Rect x="303.35" y="46.22" width="128.77" height="407.56" fill={color} />
    <Rect x="153.71" y="88.97" width="106.76" height="322.05" fill={color} />
    <Rect x="25" y="131.94" width="86.2" height="236.13" fill={color} />
  </Svg>
);

export const SyraIconActive = SyraIcon;
