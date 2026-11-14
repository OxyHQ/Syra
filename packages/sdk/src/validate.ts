/**
 * Structural validation for the API responses this SDK hands back.
 *
 * The client and the live-rooms engine used to parse every response with Zod.
 * That was correct but expensive for the apps that ship this SDK to a browser:
 * Zod's object schemas pull its whole core, and Zod 4's core pulls every error
 * locale, so a podcast card in Mention cost ~500 KiB of JavaScript. What the SDK
 * actually needs is small — "is this a string, is that an optional number, drop
 * the keys we do not name" — so it is written here in plain TypeScript.
 *
 * The rules mirror the Zod schemas this replaced (they still exist, for server
 * consumers, at `@syra.fm/sdk/schemas`), and `responses.parity.test.ts` runs both
 * over the same fixtures so the two cannot drift apart unnoticed:
 *
 *   string/number/boolean  the type, nothing else; a number must be finite
 *   optional(v)            `undefined` (or an absent key) passes; `null` does NOT
 *   nullish(v)             `undefined` and `null` both pass, and `null` is kept
 *   withDefault(v, make)   `undefined` becomes `make()`; anything else is `v`
 *   object(shape)          a non-array object; unknown keys are DROPPED
 *   looseObject(shape)     the same, but unknown keys are KEPT
 */

/** Where in the response a check failed, and why. */
export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

/** Checks one value. `path` is where that value sits, for the issue it reports. */
export type Validator<T> = (input: unknown, path: (string | number)[]) => Checked<T>;

/** One validator per key of `T` — every key, optional ones included. */
export type Shape<T> = { [K in keyof T]-?: Validator<T[K]> };

function ok<T>(value: T): Checked<T> {
  return { ok: true, value };
}

function fail(path: (string | number)[], message: string): Checked<never> {
  return { ok: false, issue: { path, message } };
}

function describe(input: unknown): string {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  return typeof input;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export const string: Validator<string> = (input, path) =>
  typeof input === 'string'
    ? ok(input)
    : fail(path, `expected string, received ${describe(input)}`);

export const number: Validator<number> = (input, path) =>
  typeof input === 'number' && Number.isFinite(input)
    ? ok(input)
    : fail(path, `expected number, received ${describe(input)}`);

export const boolean: Validator<boolean> = (input, path) =>
  typeof input === 'boolean'
    ? ok(input)
    : fail(path, `expected boolean, received ${describe(input)}`);

/** One of a fixed set of strings. */
export function oneOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return (input, path) =>
    typeof input === 'string' && values.includes(input)
      ? ok(input as T[number])
      : fail(path, `expected one of ${values.join(' | ')}`);
}

/** A further condition on a value that already passed `base`. */
export function refine<T>(base: Validator<T>, test: (value: T) => boolean, message: string) {
  return ((input, path) => {
    const checked = base(input, path);
    if (!checked.ok) return checked;
    return test(checked.value) ? checked : fail(path, message);
  }) satisfies Validator<T>;
}

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (input, path) => (input === undefined ? ok(undefined) : inner(input, path));
}

export function nullish<T>(inner: Validator<T>): Validator<T | null | undefined> {
  return (input, path) => (input === undefined || input === null ? ok(input) : inner(input, path));
}

export function withDefault<T>(inner: Validator<T>, make: () => T): Validator<T> {
  return (input, path) => (input === undefined ? ok(make()) : inner(input, path));
}

export function array<T>(inner: Validator<T>): Validator<T[]> {
  return (input, path) => {
    if (!Array.isArray(input)) return fail(path, `expected array, received ${describe(input)}`);
    const out: T[] = [];
    for (let i = 0; i < input.length; i++) {
      const checked = inner(input[i], [...path, i]);
      if (!checked.ok) return checked;
      out.push(checked.value);
    }
    return ok(out);
  };
}

/** Rewrite the input before it is checked — the response-side twin of `z.preprocess`. */
export function preprocess<T>(rewrite: (input: unknown) => unknown, inner: Validator<T>) {
  return ((input, path) => inner(rewrite(input), path)) satisfies Validator<T>;
}

function checkShape<T>(
  shape: Shape<T>,
  input: Record<string, unknown>,
  out: Record<string, unknown>,
  path: (string | number)[],
): ValidationIssue | null {
  for (const key of Object.keys(shape) as (keyof T & string)[]) {
    const checked = shape[key](input[key], [...path, key]);
    if (!checked.ok) return checked.issue;
    // An optional key the response did not send stays absent, rather than
    // appearing as `key: undefined` — what `in`/`Object.keys` callers see.
    if (checked.value === undefined && !(key in input)) delete out[key];
    else out[key] = checked.value;
  }
  return null;
}

/** An object of exactly the keys in `shape`; anything else in the response is dropped. */
export function object<T>(shape: Shape<T>): Validator<T> {
  return (input, path) => {
    if (!isRecord(input)) return fail(path, `expected object, received ${describe(input)}`);
    const out: Record<string, unknown> = {};
    const issue = checkShape(shape, input, out, path);
    return issue ? { ok: false, issue } : ok(out as T);
  };
}

/** An object with the keys in `shape` checked and every other key kept as sent. */
export function looseObject<T>(shape: Shape<T>): Validator<T> {
  return (input, path) => {
    if (!isRecord(input)) return fail(path, `expected object, received ${describe(input)}`);
    // Spread, not assignment: a response key like `__proto__` is copied as an
    // own property instead of rewriting the result's prototype.
    const out: Record<string, unknown> = { ...input };
    const issue = checkShape(shape, input, out, path);
    return issue ? { ok: false, issue } : ok(out as T);
  };
}

/** `a.b[0].c` — for messages. */
export function formatPath(path: (string | number)[]): string {
  let out = '';
  for (const part of path) {
    out += typeof part === 'number' ? `[${part}]` : out ? `.${part}` : part;
  }
  return out || '(root)';
}
