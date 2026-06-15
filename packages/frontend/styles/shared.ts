/**
 * Shared Style Utilities
 */

import { StyleSheet, ViewStyle, TextStyle, ImageStyle, StyleProp } from 'react-native';

/**
 * Flatten an array of style props into a single resolved style object.
 *
 * Wraps `StyleSheet.flatten`, which collapses nested/conditional style arrays
 * into one object, so callers can safely read individual properties off the
 * result (e.g. `flatStyle.position`).
 */
export function flattenStyleArray<T extends ViewStyle | TextStyle | ImageStyle>(
  styles: StyleProp<T> | (StyleProp<T> | undefined | null | false)[]
): T {
  return StyleSheet.flatten(styles) as T;
}
