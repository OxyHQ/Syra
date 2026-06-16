/**
 * Typography System
 * Consistent typography scales (size / weight / spacing).
 *
 * Font families are intentionally NOT defined here: the app relies entirely on
 * Bloom's font system. Bloom registers its families and sets the default text
 * font (via `BloomThemeProvider`/`FontLoader`), and the `font-sans` NativeWind
 * class resolves to Bloom's `--bloom-font-sans` token. Never hardcode a literal
 * family name in this file.
 */

/**
 * Font weights
 */
export const FONT_WEIGHTS = {
  thin: '100' as const,
  extraLight: '200' as const,
  light: '300' as const,
  regular: '400' as const,
  medium: '500' as const,
  semiBold: '600' as const,
  bold: '700' as const,
  extraBold: '800' as const,
  black: '900' as const,
} as const;

/**
 * Font size scale (based on 16px base)
 */
export const FONT_SIZES = {
  /** 10px - Tiny text */
  xs: 10,
  /** 12px - Small text */
  sm: 12,
  /** 14px - Body small */
  base: 14,
  /** 15px - Body medium */
  md: 15,
  /** 16px - Body large (base) */
  lg: 16,
  /** 18px - Heading small */
  xl: 18,
  /** 20px - Heading medium */
  '2xl': 20,
  /** 24px - Heading large */
  '3xl': 24,
  /** 30px - Display small */
  '4xl': 30,
  /** 36px - Display medium */
  '5xl': 36,
  /** 48px - Display large */
  '6xl': 48,
} as const;

/**
 * Line height scale (multiplier of font size)
 */
export const LINE_HEIGHTS = {
  /** Tight line height (1.2x) */
  tight: 1.2,
  /** Normal line height (1.5x) */
  normal: 1.5,
  /** Relaxed line height (1.75x) */
  relaxed: 1.75,
  /** Loose line height (2x) */
  loose: 2,
} as const;

/**
 * Letter spacing scale
 */
export const LETTER_SPACING = {
  /** Tighter spacing: -0.5px */
  tighter: -0.5,
  /** Tight spacing: -0.25px */
  tight: -0.25,
  /** Normal spacing: 0px */
  normal: 0,
  /** Wide spacing: 0.25px */
  wide: 0.25,
  /** Wider spacing: 0.5px */
  wider: 0.5,
} as const;

export type FontSize = typeof FONT_SIZES[keyof typeof FONT_SIZES];
export type FontWeight = typeof FONT_WEIGHTS[keyof typeof FONT_WEIGHTS];
