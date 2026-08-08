import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `main`'s PR #84 escaped the track-search query before compiling it into a
 * `RegExp`. This is that test after the PostgreSQL port, and it asserts a
 * STRONGER property than the one it replaces.
 *
 * #84's fix was `new RegExp(escapeRegex(query.trim()), 'i')` — a correct repair
 * to a real ReDoS on a public unauthenticated endpoint (`(a+)+$` against 28
 * `a`s: ~347ms unescaped, 0ms escaped, exponential in the input length). Its
 * test asserted the SOURCE, deliberately, because the defect was the ABSENCE of
 * a call and a behavioural test searching for a literal string passes
 * identically with and without the escape.
 *
 * The port removes the regex ENGINE rather than escaping its input:
 * `search_vector @@ websearch_to_tsquery(…)` has no backtracking to exploit. So
 * asserting that one call site escapes its input would now assert something
 * about a line that does not exist — and deleting the test outright would drop
 * the guard along with the code it guarded.
 *
 * What replaces it is the repo-wide form: **no source file in this backend
 * compiles a regular expression at all.** Measured at the time of writing, every
 * one of the six regex search sites the port surveyed is gone, and the only
 * `escapeRegex` left in the tree was the one this file used to define. That
 * makes the absence assertable rather than incidental, and it fails the day
 * somebody reintroduces one — including in a file #84 never touched.
 *
 * ## Comments are stripped first, and that is not hygiene
 *
 * Four files DISCUSS `new RegExp(…)` in prose, explaining what they no longer
 * do — `tracks.controller.ts` and `search.controller.ts` among them. A matcher
 * that read comments would report a regex compiler in exactly the files whose
 * only mention of one is an explanation of its removal: a false positive on the
 * files most likely to be checked, which is how a gate like this gets deleted by
 * the next person who hits it.
 */

const SRC = join(__dirname, '..');

/** Files a change to this backend can add a regex compiler to. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

/** Source with block and line comments removed. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

describe('the backend compiles no regular expression from application source', () => {
  const files = sourceFiles(SRC);

  /**
   * The vacuity floor. A broken traversal returns nothing and every absence
   * assertion below passes; this is what tells "no regex anywhere" from "the
   * walk read no files".
   */
  it('scanned the tree it is asserting about', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('finds no `new RegExp(` outside comments', () => {
    const offenders = files
      .filter((file) => /new RegExp\s*\(/.test(code(readFileSync(file, 'utf8'))))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  /**
   * The comment-stripping is itself asserted, in both directions. Without the
   * second case the stripper could eat everything and the check above would pass
   * by reading nothing at all.
   */
  it('strips a discussion of a regex but not a real one', () => {
    expect(code('/* was new RegExp(q) */\nconst a = 1;')).not.toContain('new RegExp');
    expect(code('// was new RegExp(q)\nconst a = 1;')).not.toContain('new RegExp');
    expect(code('const r = new RegExp(q);')).toContain('new RegExp');
  });

  /**
   * The port's replacement, pinned. Without this, deleting the search handler
   * entirely would satisfy every assertion above — an endpoint that cannot ReDoS
   * because it no longer exists is not the property anyone wants.
   */
  it('still searches tracks, through the full-text index', () => {
    const controller = readFileSync(join(SRC, 'controllers', 'tracks.controller.ts'), 'utf8');
    expect(controller).toContain('export const searchTracks');
    expect(code(controller)).toContain('textSearch(tracks.searchVector, query)');
  });
});
