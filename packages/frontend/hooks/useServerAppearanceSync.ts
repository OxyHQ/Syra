import { useEffect } from 'react';
import { useAuth } from '@oxy.so/services/ui/client';
import { useBloomTheme, type ThemeMode } from '@oxy.so/bloom/theme';
import { useMyAppearanceSettings } from '@/store/appearanceStore';

const VALID_THEME_MODES: ReadonlySet<ThemeMode> = new Set<ThemeMode>([
  'light',
  'dark',
  'system',
  'adaptive',
]);

function isValidThemeMode(value: string | undefined): value is ThemeMode {
  return typeof value === 'string' && VALID_THEME_MODES.has(value as ThemeMode);
}

/**
 * Bridges the persisted theme mode (stored in Syra's appearance settings) into
 * the live Bloom theme so the saved preference actually drives
 * `BloomThemeProvider`. The accent colour is the Oxy account colour and is owned
 * by `useAccountColor`, not by these settings.
 *
 * Loading server settings and pushing them into Bloom's imperative `setMode`
 * API are synchronisations with external systems,
 * which is one of the few legitimate uses of `useEffect`.
 */
export function useServerAppearanceSync(): void {
  const { canUsePrivateApi } = useAuth();
  const { data: mySettings } = useMyAppearanceSettings(canUsePrivateApi);
  const { setMode } = useBloomTheme();

  useEffect(() => {
    const appearance = mySettings?.appearance;
    if (!appearance) return;

    if (isValidThemeMode(appearance.themeMode)) {
      setMode(appearance.themeMode);
    }
  }, [mySettings, setMode]);
}
