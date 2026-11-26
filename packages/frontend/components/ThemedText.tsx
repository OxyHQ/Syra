import { Platform, StyleSheet, Text, type TextProps } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};

export function ThemedText({ style, type = 'default', ...rest }: ThemedTextProps) {
  const themed = useThemedStyles();
  return (
    <Text
      style={[
        type === 'link' ? themed.link : themed.foreground,
        styles.family,
        styles[type],
        style,
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  // What `font-sans` drew. Web: Syra's `--font-sans` (styles/global.css). Native:
  // NativeWind's theme.css sets `--font-sans` unlayered per platform, which beat
  // Syra's layered `@theme` value: `System` on iOS and `SystemAndroid` on Android
  // (no such family, so Android draws its default face).
  family: Platform.select({
    web: { fontFamily: 'var(--bloom-font-sans), sans-serif' },
    ios: { fontFamily: 'System' },
    android: { fontFamily: 'SystemAndroid' },
    default: {},
  }),
  default: { fontSize: 16, lineHeight: 24 },
  defaultSemiBold: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  // `leading-8`: NativeWind's `leading-*` override is `calc(var(--spacing) / 1rem * 8)`.
  // Native reads it as 32; the web computes the unitless 2, so twice the 32px size.
  title: {
    fontSize: 32,
    lineHeight: Platform.OS === 'web' ? 64 : 32,
    fontWeight: '700',
  },
  subtitle: { fontSize: 20, lineHeight: 28, fontWeight: '700' },
  link: { fontSize: 16, lineHeight: 30 },
});

const useThemedStyles = createTokenStyles((t) => ({
  foreground: { color: t.foreground },
  link: { color: t.primary },
}));
