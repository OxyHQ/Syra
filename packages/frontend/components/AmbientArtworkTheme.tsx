import React, { useMemo } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { BloomSeedScope } from '@oxyhq/bloom/theme';

import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import { webViewStyle } from '../utils/webStyles';

interface AmbientArtworkThemeProps {
  /**
   * Extracted artwork seed (`#rrggbb`). When `null`/`undefined` the region keeps
   * the app preset (BloomSeedScope is a no-op), so passing `null` on
   * mouse-leave/blur restores the default theme.
   */
  seed: string | null | undefined;
  /**
   * Transition duration for the ambient re-theme, in ms. Snaps instantly when
   * the user prefers reduced motion. Defaults to 480ms.
   */
  durationMs?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * Scopes a region to an artwork-derived seed palette and eases the ambient
 * surfaces into the new colours.
 *
 * The scope publishes the engine's role colours as `--background` / `--card` /
 * `--primary` … CSS vars over this subtree, so any `bg-background` / `bg-card`
 * surface inside re-themes to match the artwork. The wrapper carries a
 * `background-color` + `color` CSS transition (web) so the swap cross-fades
 * rather than flashing; reduced-motion callers snap. Native is a no-op wrapper
 * (seed extraction is web-only today), so the app preset is untouched there.
 *
 * Intentionally tints ambient surfaces only — the accent (`--primary`) shifts
 * with the palette but nothing here hard-flashes it across the whole app.
 */
export function AmbientArtworkTheme({
  seed,
  durationMs = 480,
  style,
  children,
}: AmbientArtworkThemeProps) {
  const reducedMotion = usePrefersReducedMotion();

  const transitionStyle = useMemo<ViewStyle>(() => {
    if (reducedMotion) return {};
    return webViewStyle({
      transitionProperty: 'background-color, color, border-color',
      transitionDuration: `${durationMs}ms`,
      transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)',
    });
  }, [reducedMotion, durationMs]);

  return (
    <BloomSeedScope seed={seed ?? undefined}>
      <View style={[{ flex: 1 }, transitionStyle, style]}>{children}</View>
    </BloomSeedScope>
  );
}
