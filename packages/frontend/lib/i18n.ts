/**
 * i18n Configuration and Initialization
 * Separated from _layout.tsx for better testability and maintainability
 */

import i18n, { init as i18nInit, use as i18nUse } from 'i18next';
import { initReactI18next } from 'react-i18next';

import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';
import itIT from '@/locales/it.json';

import { DEFAULT_LANGUAGE, STORAGE_KEYS } from './constants';
import { getData } from '@/utils/storage';

const i18nResources = {
  'en-US': { translation: enUS },
  'es-ES': { translation: esES },
  'it-IT': { translation: itIT },
} as const;

/**
 * Suspense is disabled deliberately.
 *
 * react-i18next defaults `useSuspense` to true, which makes `useTranslation`
 * throw a promise whenever an i18n instance exists but is not yet initialized
 * (useTranslation.js: `if (i18n && useSuspense && !ready) throw new Promise(...)`).
 * i18n here initializes from a layout effect, so a component mounted in the
 * providers tree that calls `t()` can suspend before any Suspense boundary
 * exists above it — a white screen with no console error.
 *
 * Today that is avoided only by accident: on the first render `getI18n()` is
 * still undefined, so the throw is skipped. That holds until someone moves
 * initialization earlier or mounts another translated component high in the tree.
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
 * Initializes i18n with the saved language preference
 */
export async function initializeI18n(): Promise<void> {
  try {
    const initialLanguage = await loadSavedLanguage();

    if (i18n.isInitialized) {
      // If already initialized, just change the language
      await i18n.changeLanguage(initialLanguage);
      return;
    }

    // Initialize i18n with the saved language
    i18nUse(initReactI18next);
    await i18nInit({
      resources: i18nResources,
      lng: initialLanguage,
      fallbackLng: DEFAULT_LANGUAGE,
      interpolation: { escapeValue: false },
      react: REACT_I18NEXT_OPTIONS,
    });
  } catch (error) {
    console.error('i18n initialization failed:', error);
    // Fallback to default initialization
    if (!i18n.isInitialized) {
      try {
        i18nUse(initReactI18next);
        await i18nInit({
          resources: i18nResources,
          lng: DEFAULT_LANGUAGE,
          fallbackLng: DEFAULT_LANGUAGE,
          interpolation: { escapeValue: false },
          // Must carry the same react options as the primary init above: a
          // boot-mounted consumer calling `useTranslation` suspends forever if
          // this path ever runs with the library default of `useSuspense: true`,
          // and the symptom is a white screen with no console error.
          react: REACT_I18NEXT_OPTIONS,
        });
      } catch (fallbackError) {
        console.error('i18n fallback initialization failed:', fallbackError);
        throw fallbackError;
      }
    }
  }
}

export default i18n;

