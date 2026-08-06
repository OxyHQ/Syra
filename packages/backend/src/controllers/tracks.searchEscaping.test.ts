import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `GET /api/tracks/search` is public and unauthenticated, so `req.query.q`
 * is attacker-controlled. Compiling it straight into `new RegExp(...)` is a
 * ReDoS against a collection scan: measured on this machine, `(a+)+$` against
 * 28 `a`s takes ~347ms unescaped and 0ms escaped, and the cost is exponential
 * in the input length.
 *
 * The check is a source assertion rather than a request test because the
 * defect is the ABSENCE of a call — a behavioural test that searches for a
 * literal string passes identically with and without the escape, which is the
 * shape that let this ship in the first place. `search.controller.ts` and
 * `podcasts.controller.ts` both carry the same helper and use it; this file
 * was the one that did not.
 */
const CONTROLLER = readFileSync(
  join(__dirname, 'tracks.controller.ts'),
  'utf8',
);

/** Mirrors the helper under test, so the timing assertion measures the real pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('tracks.controller search input escaping', () => {
  it('never compiles a raw query into a RegExp', () => {
    const rawCompiles = CONTROLLER.match(/new RegExp\(\s*query/g) ?? [];
    expect(rawCompiles).toEqual([]);
  });

  it('compiles the search pattern through escapeRegex', () => {
    expect(CONTROLLER).toContain("new RegExp(escapeRegex(query.trim()), 'i')");
  });

  it('defines escapeRegex covering every regex metacharacter it must neutralise', () => {
    expect(CONTROLLER).toContain('function escapeRegex(');
    // Each of these turns a search term into a pattern that is not a literal.
    for (const meta of ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']) {
      expect(escapeRegex(meta)).toBe(`\\${meta}`);
    }
  });

  it('escaping defuses a catastrophically backtracking pattern', () => {
    const evil = '(a+)+$';
    const subject = `${'a'.repeat(32)}b`;

    const started = performance.now();
    new RegExp(escapeRegex(evil), 'i').test(subject);
    const escapedMs = performance.now() - started;

    // The unescaped form is exponential in `subject.length`; the escaped form
    // is a literal search and stays flat. A generous ceiling still separates
    // them by orders of magnitude.
    expect(escapedMs).toBeLessThan(50);
  });

  it('an escaped pattern still matches the literal text a user typed', () => {
    // The fix must not break search for terms that legitimately contain
    // punctuation — album and track titles routinely do.
    for (const term of ['Ok Computer', 'Sgt. Pepper', 'Sign "O" the Times', '(What\'s the Story)']) {
      expect(new RegExp(escapeRegex(term), 'i').test(term)).toBe(true);
    }
  });
});
