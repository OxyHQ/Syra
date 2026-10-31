import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInstance } from 'i18next';
import i18n, { initializeI18n, restoreLocale, type LocalePatch } from './i18n';
import { DEFAULT_LANGUAGE } from './constants';
import { getData } from '@/utils/storage';

jest.mock('@/utils/storage', () => ({ getData: jest.fn() }));

const locales = {
  'en-US': 'en',
  'es-ES': 'es',
  'it-IT': 'it',
  'fr-FR': 'fr',
  'de-DE': 'de',
  'pt-BR': 'pt-BR',
  'zh-CN': 'zh-CN',
  'hi-IN': 'hi',
  'ar-SA': 'ar',
  'bn-BD': 'bn',
  'ru-RU': 'ru',
  'ja-JP': 'ja',
  'ur-PK': 'ur',
  'id-ID': 'id',
  'tr-TR': 'tr',
  'ca-ES': 'ca',
} as const;
const readLocale = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, '../locales', `${name}.json`), 'utf8'));

it('preserves empty values, arrays and missing keys without sharing mutable values', () => {
  const base = { keep: { value: '' }, list: ['base'], missing: 'base' };
  const replacement = { keep: { value: '' }, list: ['new', { nested: true }] };
  const copy = restoreLocale(base, [1, replacement]) as typeof replacement;
  expect(copy).toEqual(replacement);
  expect('missing' in copy).toBe(false);
  copy.list[1] = 'changed';
  expect(replacement.list[1]).toEqual({ nested: true });
  const unchanged = restoreLocale(base, [0]) as typeof base;
  unchanged.keep.value = 'changed';
  expect(base.keep.value).toBe('');
  const partial = restoreLocale(base, [
    2,
    { keep: [2, { value: [1, 'translated'] }] },
  ]) as typeof base;
  partial.list.push('changed');
  expect(base.list).toEqual(['base']);
  expect(partial.keep.value).toBe('translated');
});

it('registers all 16 complete catalogs synchronously and restores exact values and order', () => {
  expect(i18n.isInitialized).toBe(true);
  expect(i18n.language).toBe(DEFAULT_LANGUAGE);
  const english = readLocale('en');
  for (const [language, name] of Object.entries(locales)) {
    const original = readLocale(name);
    const actual = i18n.getResourceBundle(language, 'translation');
    expect(JSON.stringify(actual)).toBe(JSON.stringify(original));
    if (name !== 'en') {
      const patch = readLocale(`compact/${name}.generated`) as LocalePatch;
      expect(JSON.stringify(restoreLocale(english, patch))).toBe(JSON.stringify(original));
      expect(actual).not.toBe(english);
    }
  }
});

it('preserves plural resolution, interpolation, missing keys and saved-language selection', async () => {
  const resources = Object.fromEntries(
    Object.entries(locales).map(([code, name]) => [code, { translation: readLocale(name) }]),
  );
  const original = createInstance();
  await original.init({
    resources,
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
  });
  const keys = [
    'uploads.submit',
    'uploads.toasts.batchDone',
    'uploads.toasts.batchNeedsAttention',
    'missing.example',
  ];
  for (const language of Object.keys(locales)) {
    for (const key of keys) {
      for (const count of [0, 1, 2, 3, 11, 101]) {
        const options = { lng: language, count, total: 5 };
        expect(i18n.t(key, options)).toBe(original.t(key, options));
      }
    }
  }
  jest.mocked(getData).mockResolvedValueOnce('ca-ES');
  await initializeI18n();
  expect(i18n.language).toBe('ca-ES');
  expect(i18n.t('uploads.submit', { count: 3 })).toBe(
    original.t('uploads.submit', { lng: 'ca-ES', count: 3 }),
  );
  await i18n.changeLanguage(DEFAULT_LANGUAGE);
});
