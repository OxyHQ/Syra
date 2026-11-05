/**
 * i18n Configuration and Initialization
 * Separated from _layout.tsx for better testability and maintainability
 */

import i18n, { init as i18nInit, use as i18nUse } from 'i18next';
import { initReactI18next } from 'react-i18next';

import enUS from '@/locales/en.json';
import esES from '@/locales/compact/es.generated.json';
import itIT from '@/locales/compact/it.generated.json';
import ar from '@/locales/compact/ar.generated.json';
import bn from '@/locales/compact/bn.generated.json';
import ca from '@/locales/compact/ca.generated.json';
import de from '@/locales/compact/de.generated.json';
import fr from '@/locales/compact/fr.generated.json';
import hi from '@/locales/compact/hi.generated.json';
import id from '@/locales/compact/id.generated.json';
import ja from '@/locales/compact/ja.generated.json';
import ptBR from '@/locales/compact/pt-BR.generated.json';
import ru from '@/locales/compact/ru.generated.json';
import tr from '@/locales/compact/tr.generated.json';
import ur from '@/locales/compact/ur.generated.json';
import zhCN from '@/locales/compact/zh-CN.generated.json';

import { DEFAULT_LANGUAGE, STORAGE_KEYS } from './constants';
import { getData } from '@/utils/storage';

/** A compact JSON tree: unchanged, replace, or recurse into an equal-key object. */
export type LocalePatch = [0] | [1, unknown] | [2, Record<string, LocalePatch>];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}

/** Rebuild a separate locale tree synchronously, retaining missing keys and value order. */
export function restoreLocale(base: unknown, patch: LocalePatch): unknown {
  if (patch[0] === 0) return clone(base);
  if (patch[0] === 1) return clone(patch[1]);
  if (!isRecord(base)) throw new Error('Invalid compact locale patch');
  const changes = patch[1];
  return Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      Object.hasOwn(changes, key) ? restoreLocale(value, changes[key]) : clone(value),
    ]),
  );
}

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

const restore = (patch: unknown) => restoreLocale(enUS, patch as LocalePatch) as typeof enUS;

const i18nResources = {
  'en-US': { translation: enUS },
  'es-ES': { translation: restore(esES) },
  'it-IT': { translation: restore(itIT) },
  'fr-FR': { translation: restore(fr) },
  'de-DE': { translation: restore(de) },
  'pt-BR': { translation: restore(ptBR) },
  'zh-CN': { translation: restore(zhCN) },
  'hi-IN': { translation: restore(hi) },
  'ar-SA': { translation: restore(ar) },
  'bn-BD': { translation: restore(bn) },
  'ru-RU': { translation: restore(ru) },
  'ja-JP': { translation: restore(ja) },
  'ur-PK': { translation: restore(ur) },
  'id-ID': { translation: restore(id) },
  'tr-TR': { translation: restore(tr) },
  'ca-ES': { translation: restore(ca) },
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
