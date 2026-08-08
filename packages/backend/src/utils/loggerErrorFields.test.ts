import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Invariant: a caught error never reaches a log field raw.
 *
 * `utils/error.ts` states the hazard in its own header — *"a postgres.js error
 * carries `query`, `params` and `detail`, so `logger.error(msg, { error })`
 * writes the whole statement and every bound parameter into the log"* — and
 * ships `describeErrorSafely` for it. Nothing enforced that the helper was
 * USED, so ten files adopted it and twenty-five did not, which is the shape a
 * per-call-site rule always fails in: nothing distinguishes the seventh file
 * from the ninth, and "be more careful" is not a remedy.
 *
 * The trigger was `routes/reports.routes.ts`, flagged on a PR by a reviewer
 * that could only see the diff — the payload there is a moderation report's
 * `details`, which is user-submitted and is exactly the content someone would
 * file a report ABOUT. The rest predate it and were invisible for the same
 * reason.
 *
 * So the check enumerates the log calls from the SOURCE rather than from a list
 * someone maintained, and there is deliberately **no exemption registry**: an
 * allowlist the size of this class would be the finding rather than the fix.
 * The one site with a genuine argument for logging raw — the fingerprint
 * backfill, which branches on `isDriverError` and logs `{ err }` only on the
 * non-driver path — conforms instead, because `describeErrorSafely` returns the
 * message for exactly that case and the branch that routes the operator to the
 * right subsystem is untouched.
 *
 * ## What counts as raw
 *
 * A property of a `logger.*` object argument whose VALUE is the bare catch
 * binding — `{ err }`, `{ error }`, `{ err: error }`, `{ error: e }`. A value
 * built by `describeErrorSafely`, `describeDriverError`, `getErrorMessage` or
 * `getErrorStack` is fine, and so is a string literal.
 *
 * Comments are stripped first. `utils/error.ts` and the fingerprint backfill
 * both DISCUSS `logger.error(msg, { error })` in prose while explaining why not
 * to write it — a matcher that read comments would flag the two files that
 * document the rule, which is how a gate gets deleted by whoever hits it next.
 */

const SRC = join(__dirname, '..');

/** The safe renderers. A value produced by any of these is not raw. */
const SAFE = ['describeErrorSafely', 'describeDriverError', 'getErrorMessage', 'getErrorStack'];

/** The identifiers a catch clause in this repo binds. */
const CATCH_BINDINGS = ['err', 'error', 'e'];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    found.push(full);
  }
  return found;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * The text of every `logger.<level>(…)` call, balanced to its closing paren so
 * a nested object or template literal cannot end the match early.
 */
export function loggerCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /logger\.(?:error|warn|info|debug)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') depth -= 1;
      index += 1;
    }
    calls.push(source.slice(match.index, index));
  }
  return calls;
}

/** The raw catch bindings a single logger call passes as a field value. */
export function rawErrorFields(call: string): string[] {
  const found: string[] = [];
  for (const binding of CATCH_BINDINGS) {
    /**
     * `{ err }`, `, err }`, `, err,` — the shorthand property — and `, error)`,
     * the binding passed POSITIONALLY as the last argument. The terminator set
     * includes `)` for that last shape: without it a call ending
     * `logger.error(msg, error)` slips through, which is the same hazard wearing
     * a different comma.
     */
    const shorthand = new RegExp(`[{,]\\s*${binding}\\s*[,})]`);
    /** `err: error` — an explicit key whose value is a bare binding. */
    const explicit = new RegExp(`[{,]\\s*[A-Za-z_$][\\w$]*\\s*:\\s*${binding}\\s*[,})]`);
    if (shorthand.test(call) || explicit.test(call)) found.push(binding);
  }
  return found;
}

describe('no caught error reaches a log field raw', () => {
  const files = sourceFiles(SRC);

  /**
   * The vacuity floor. A broken traversal returns nothing and every absence
   * assertion below passes, so this is what tells "no raw error anywhere" from
   * "the walk read no files".
   */
  it('scanned the tree it is asserting about', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('finds no logger call passing a bare catch binding', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const call of loggerCalls(code)) {
        if (SAFE.some((safe) => call.includes(`${safe}(`))) continue;
        const raw = rawErrorFields(call);
        if (raw.length > 0) {
          offenders.push(`${file.slice(SRC.length + 1)} :: ${raw.join(', ')}`);
        }
      }
    }
    // Named, so a failure says WHICH file rather than a count.
    expect(offenders).toEqual([]);
  });

  /**
   * The detector, in both directions. Without the negative cases it could flag
   * everything; without the positive ones it could flag nothing, and either way
   * the sweep above would be meaningless.
   */
  it('recognises a raw field and leaves a safe one alone', () => {
    expect(rawErrorFields("logger.error('x', { err })")).toEqual(['err']);
    expect(rawErrorFields("logger.error('x', { err: error })")).toEqual(['error']);
    expect(rawErrorFields("logger.error('x', { userId, error, query })")).toEqual(['error']);
    expect(rawErrorFields("logger.error('x', { e })")).toEqual(['e']);

    expect(rawErrorFields("logger.error('x', { err: describeErrorSafely(error) })")).toEqual([]);
    expect(rawErrorFields("logger.error('x', { error: 'a fixed string' })")).toEqual([]);
    // A key that merely CONTAINS a binding name is not that binding.
    expect(rawErrorFields("logger.error('x', { errorCode, errors })")).toEqual([]);
    expect(rawErrorFields("logger.error('x', { reported })")).toEqual([]);

    // A bare binding passed POSITIONALLY rather than as a field. Caught for the
    // same reason and by the same comma, and it is not a hypothetical shape:
    // `services/strikeService.ts` passed one, which is how it was found. The
    // fixture is here because the detector cannot tell the two apart and should
    // not — both hand the raw error to the logger.
    expect(rawErrorFields("logger.error(`msg ${id}`, error)")).toEqual(['error']);
  });

  it('balances the call to its own closing paren', () => {
    // A nested call must not end the match early, or a raw field after it hides.
    const calls = loggerCalls("logger.error(fmt(a, b), { err });\nconst x = 1;");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('{ err }');
  });

  it('strips a discussion of the hazard but not a real call', () => {
    expect(stripComments('/* logger.error(m, { error }) */')).not.toContain('logger.error');
    expect(stripComments('// logger.error(m, { error })')).not.toContain('logger.error');
    expect(stripComments("logger.error(m, { error });")).toContain('logger.error');
  });
});
