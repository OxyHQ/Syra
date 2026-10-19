import type { ViewStyle, ImageStyle, TextStyle, DimensionValue } from 'react-native';

/**
 * Web-only style escape hatch for react-native-web.
 *
 * react-native-web accepts a handful of CSS properties at runtime that are not
 * part of React Native's `ViewStyle`/`TextStyle` type unions (e.g. `overflowY`,
 * `position: 'fixed'`, `transition`). These styles only ever reach the DOM on
 * web (they are wrapped in `Platform.select({ web: ... })` or guarded by
 * `Platform.OS === 'web'`), so this helper takes the loosely-typed web CSS bag
 * and returns it as a strict RN style object, keeping call sites free of `any`.
 */
interface WebOnlyProps {
  position?: 'fixed' | 'sticky' | 'absolute' | 'relative' | 'static';
  overflowY?: 'auto' | 'hidden' | 'scroll' | 'visible';
  overflowX?: 'auto' | 'hidden' | 'scroll' | 'visible';
  transition?: string;
  transitionProperty?: string;
  transitionDuration?: string;
  transitionTimingFunction?: string;
  boxShadow?: string;
  outlineStyle?: 'auto' | 'none' | 'dotted' | 'dashed' | 'solid';
  cursor?: string;
  whiteSpace?: 'normal' | 'nowrap' | 'pre' | 'pre-wrap' | 'pre-line' | 'break-spaces';
  /** Allows web sizing strings such as `calc(...)` and viewport units. */
  width?: DimensionValue;
  height?: DimensionValue;
  maxHeight?: DimensionValue;
  minHeight?: DimensionValue;
}

/** RN style with the web-only props layered over the conflicting RN keys. */
type WebStyle<T> = Omit<T, keyof WebOnlyProps> & WebOnlyProps;

/**
 * Keys Expo's react-native-web augmentation (`expo/types/react-native-web.d.ts`)
 * types more loosely on `ViewStyle` than on `TextStyle`: `userSelect` as any
 * string and `transitionDuration` as also a number. RN 0.88's `StyleSheet.create`
 * and `StyleSheet.flatten` check every entry against the combined text/image
 * style, so a value typed as the full `ViewStyle` is rejected there. Taking
 * these two keys from `TextStyle` keeps the result assignable to both.
 */
type ViewTextConflictKeys = 'userSelect' | 'transitionDuration';

/** A `ViewStyle` that `StyleSheet.create` and `StyleSheet.flatten` accept. */
export type SheetViewStyle = Omit<ViewStyle, ViewTextConflictKeys> &
  Pick<TextStyle, ViewTextConflictKeys>;

/**
 * Tag a web-only CSS bag as a React Native view style.
 */
export function webViewStyle(style: WebStyle<ViewStyle>): SheetViewStyle {
  return style as SheetViewStyle;
}

/**
 * Tag a web-only CSS bag as a React Native `ImageStyle`.
 */
export function webImageStyle(style: WebStyle<ImageStyle>): ImageStyle {
  return style as ImageStyle;
}

/**
 * Tag a web-only CSS bag as a React Native `TextStyle`.
 */
export function webTextStyle(style: WebStyle<TextStyle>): TextStyle {
  return style as TextStyle;
}

/**
 * Cast a web sizing string (`calc(...)`, `100vh`, `48%`, …) to `DimensionValue`.
 * Only valid on web; native callers must pass a number or percentage.
 */
export function webDimension(value: string): DimensionValue {
  return value as DimensionValue;
}
