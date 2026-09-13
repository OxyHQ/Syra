/**
 * i18n Configuration and Initialization
 * Separated from _layout.tsx for better testability and maintainability
 */

import i18n, { init as i18nInit, use as i18nUse } from 'i18next';
import { initReactI18next } from 'react-i18next';

import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';
import itIT from '@/locales/it.json';
import ar from '@/locales/ar.json';
import bn from '@/locales/bn.json';
import ca from '@/locales/ca.json';
import de from '@/locales/de.json';
import fr from '@/locales/fr.json';
import hi from '@/locales/hi.json';
import id from '@/locales/id.json';
import ja from '@/locales/ja.json';
import ptBR from '@/locales/pt-BR.json';
import ru from '@/locales/ru.json';
import tr from '@/locales/tr.json';
import ur from '@/locales/ur.json';
import zhCN from '@/locales/zh-CN.json';

import { DEFAULT_LANGUAGE, STORAGE_KEYS } from './constants';
import { getData } from '@/utils/storage';

/**
 * Registered SYNCHRONOUSLY, at module load, and deliberately not inside
 * `initializeI18n`.
 *
 * `initReactI18next` is what installs the global instance react-i18next falls
 * back to when a component has no `I18nextProvider` above it. Doing it inside
 * the async initializer left a window — from first render until that promise
 * resolved — in which no global existed at all, and every `useTranslation()`
 * reached in that window threw `NO_I18NEXT_INSTANCE`. The window is exactly the
 * app's cold boot, which is when the most components mount at once.
 *
 * The language still loads asynchronously; only the registration moves.
 */
i18nUse(initReactI18next);

const i18nResources = {
  'en-US': { translation: enUS },
  'es-ES': { translation: esES },
  'it-IT': { translation: itIT },
  'fr-FR': { translation: fr },
  'de-DE': { translation: de },
  'pt-BR': { translation: ptBR },
  'zh-CN': { translation: zhCN },
  'hi-IN': { translation: hi },
  'ar-SA': { translation: ar },
  'bn-BD': { translation: bn },
  'ru-RU': { translation: ru },
  'ja-JP': { translation: ja },
  'ur-PK': { translation: ur },
  'id-ID': { translation: id },
  'tr-TR': { translation: tr },
  'ca-ES': { translation: ca },
} as const;

/**
 * Suspense is disabled deliberately.
 *
 * react-i18next defaults `useSuspense` to true, which makes `useTranslation`
 * throw a promise whenever an i18n instance exists but is not yet initialized
 * (useTranslation.js: `if (i18n && useSuspense && !ready) throw new Promise(...)`).
 * See the note below, beside the synchronous `i18nInit` call, for why that used
 * to be reachable on cold boot and produce a permanent blank screen.
 *
 * Every locale is bundled synchronously — there is no namespace or backend to
 * wait on — so suspense buys nothing here. With it off, a `t()` call before
 * initialization returns the key (or its `defaultValue`) instead of suspending.
 */
const REACT_I18NEXT_OPTIONS = { useSuspense: false } as const;

export interface I18nConfig {
  resources: typeof i18nResources;
  lng: string;
  fallbackLng: string;
  interpolation: { escapeValue: boolean };
}

/**
 * Also registered SYNCHRONOUSLY, at module load, right beside `.use()` above —
 * for the same reason, one level deeper.
 *
 * `.use(initReactI18next)` alone only fixes the case where `getI18n()` returns
 * undefined. It does nothing for the case where the instance exists but isn't
 * ready yet: `useTranslation()` resolves `i18n` from `I18nextProvider` context
 * (not the global fallback) for anything rendered inside `<I18nextProvider
 * i18n={i18n}>`, so that check always finds a truthy instance. Until `.init()`
 * has actually run, `i18n.isInitialized` is false and `options.react` is unset,
 * so react-i18next falls back to ITS OWN default of `useSuspense: true` — and
 * `useTranslation`'s last line is `if (i18n && useSuspense && !ready) throw new
 * Promise(...)`. Any translated component mounted inside the provider on the
 * first render (e.g. `PlaybackFailureReporter` in AppProviders) throws that
 * promise with no Suspense boundary above it anywhere in the tree.
 *
 * On a cold boot that first render is the ONLY render: `entry.js` wraps the
 * initial `registerRootComponent` in `startTransition`, so React holds the
 * whole tree uncommitted rather than erroring — including `RootLayout` itself,
 * whose own `useEffect` is what calls `initializeI18n()` below. Nothing ever
 * commits, so that effect never runs, so `.init()` never runs, so the thrown
 * promise never resolves. The result is a permanently blank page with no
 * console error and no network activity — indistinguishable from a hang.
 *
 * i18next's `init()` runs its setup SYNCHRONOUSLY when resources are passed
 * inline with no backend to await (as here — every locale is bundled), so
 * calling it here, synchronously, closes the window completely: by the time
 * any component can render, `isInitialized` is already true and
 * `useSuspense` is already false. It starts on `DEFAULT_LANGUAGE`; the saved
 * preference is applied afterward by `initializeI18n`, via `changeLanguage`,
 * which needs no suspense fix of its own since the instance is already ready.
 */
try {
  i18nInit({
    resources: i18nResources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
    react: REACT_I18NEXT_OPTIONS,
  });
} catch (error) {
  console.error('Synchronous i18n initialization failed:', error);
}

/**
 * Loads the saved language preference from storage
 */
export async function loadSavedLanguage(): Promise<string> {
  try {
    const savedLanguage = await getData<string>(STORAGE_KEYS.LANGUAGE_PREFERENCE);
    return savedLanguage || DEFAULT_LANGUAGE;
  } catch (error) {
    console.error('Failed to load saved language:', error);
    return DEFAULT_LANGUAGE;
  }
}

/**
 * Switches i18n to the saved language preference, once it has loaded from
 * storage. `i18n` is already initialized synchronously above by the time this
 * runs — this only ever changes the active language, it never gates readiness.
 */
export async function initializeI18n(): Promise<void> {
  try {
    const initialLanguage = await loadSavedLanguage();
    if (initialLanguage !== i18n.language) {
      await i18n.changeLanguage(initialLanguage);
    }
  } catch (error) {
    console.error('Failed to apply saved language preference:', error);
  }
}

export default i18n;

