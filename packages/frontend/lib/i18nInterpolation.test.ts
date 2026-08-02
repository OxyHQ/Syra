/**
 * Do the strings that carry VALUES actually receive them?
 *
 * `bun run check-i18n` answers a different question — whether a key exists in
 * all three locales — and it is blind to this one by construction: a string is
 * present and in lockstep whether or not the call site passes the variable it
 * interpolates. So `t('uploads.toasts.batchDone', { count: n })` against
 * `"All {{total}} files finished."` passes every existing gate and renders the
 * literal text `{{total}}` to the user, in every language.
 *
 * That is not hypothetical: it is the bug this file was written after making.
 *
 * The count option is the sharper edge of the same problem. Passing `count` puts
 * i18next into PLURAL resolution — it looks for `key_one` / `key_other` and
 * falls back to the bare key — so a plural string reached without `count` picks
 * the wrong form, and a non-plural string reached WITH it silently changes which
 * entry is looked up.
 *
 * Every locale is asserted rather than English alone, because a translator
 * rewriting a sentence is exactly when a placeholder gets dropped, and the
 * language that loses it is the one nobody on the team is reading.
 */

import i18n, { init as i18nInit } from 'i18next';

import enUS from '@/locales/en.json';
import esES from '@/locales/es.json';
import itIT from '@/locales/it.json';

const LOCALES = { 'en-US': enUS, 'es-ES': esES, 'it-IT': itIT } as const;

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18nInit({
      resources: Object.fromEntries(
        Object.entries(LOCALES).map(([code, translation]) => [code, { translation }]),
      ),
      lng: 'en-US',
      fallbackLng: 'en-US',
      interpolation: { escapeValue: false },
    });
  }
});

/**
 * Every `t()` call on the upload screen that passes values, with the values the
 * screen really passes. Kept as literal call shapes so a rename at the call site
 * and a rename here cannot drift apart silently — the assertion below is that
 * nothing `{{like this}}` survives into the rendered string.
 */
const INTERPOLATED_CALLS: ReadonlyArray<{
  key: string;
  values: Record<string, number>;
  /** A substring the rendered form must contain, proving the value landed. */
  expects: string;
}> = [
  { key: 'uploads.submit', values: { count: 1 }, expects: '1' },
  { key: 'uploads.submit', values: { count: 7 }, expects: '7' },
  { key: 'uploads.toasts.batchDone', values: { total: 4 }, expects: '4' },
  {
    key: 'uploads.toasts.batchNeedsAttention',
    values: { count: 1, total: 3 },
    expects: '3',
  },
  {
    key: 'uploads.toasts.batchNeedsAttention',
    values: { count: 2, total: 5 },
    expects: '5',
  },
];

describe('upload screen strings interpolate in every locale', () => {
  it('the corpus is not empty', () => {
    // Vacuity floor: every assertion below is "nothing was left unreplaced",
    // which an empty list satisfies perfectly.
    expect(INTERPOLATED_CALLS.length).toBeGreaterThan(4);
  });

  for (const code of Object.keys(LOCALES)) {
    for (const { key, values, expects } of INTERPOLATED_CALLS) {
      it(`${code} — ${key} (${JSON.stringify(values)})`, async () => {
        await i18n.changeLanguage(code);
        const rendered = i18n.t(key, values);

        // The key itself coming back means it did not resolve at all.
        expect(rendered).not.toBe(key);
        // An unreplaced placeholder is the failure this file exists for.
        expect(rendered).not.toMatch(/\{\{/);
        // And the value has to actually appear, so a string that dropped the
        // placeholder entirely is caught too — that renders cleanly and says
        // nothing about how many files there were.
        expect(rendered).toContain(expects);
      });
    }
  }

  it('both plural forms of a count string are distinct', async () => {
    // Without this, a locale whose `_one` and `_other` were copy-pasted would
    // pass every assertion above while reading wrong for one of the two cases.
    for (const code of Object.keys(LOCALES)) {
      await i18n.changeLanguage(code);
      const one = i18n.t('uploads.toasts.batchNeedsAttention', { count: 1, total: 3 });
      const other = i18n.t('uploads.toasts.batchNeedsAttention', { count: 2, total: 3 });
      expect(`${code}: ${one === other ? 'identical' : 'distinct'}`).toBe(`${code}: distinct`);
    }
  });
});
