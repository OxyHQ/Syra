/**
 * Shared Style Utilities
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle, StyleProp } from 'react-native';
import type { SheetViewStyle } from '@/utils/webStyles';

/**
 * Flatten an array of style props into a single resolved style object.
 *
 * Wraps `StyleSheet.flatten`, which collapses nested/conditional style arrays
 * into one object, so callers can safely read individual properties off the
 * result (e.g. `flatStyle.position`).
 */
export function flattenStyleArray<T extends ViewStyle | TextStyle | ImageStyle>(
  styles: StyleProp<T> | (StyleProp<T> | undefined | null | false)[],
): T {
  // Expo's react-native-web augmentation types `ViewStyle` (and `ImageStyle`,
  // which RN 0.88 derives from it) more loosely than `flatten` accepts — see
  // `SheetViewStyle`. Only the static type is narrowed; the value is unchanged.
  return StyleSheet.flatten(styles as StyleProp<SheetViewStyle | TextStyle>) as T;
}
