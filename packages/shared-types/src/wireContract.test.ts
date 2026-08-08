import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The wire contract's one standing rule: a row's id is spelled `id`.
 *
 * `common.ts` explains why `_id` left. This is the gate that keeps it gone,
 * and it is a source scan rather than a check on the inferred TypeScript types
 * because that is where the failure would actually appear: a zod schema is
 * built from an object literal, so an `_id` added back is a new optional
 * property on an inferred type — it widens the contract without breaking a
 * single consumer's `tsc`. Nothing else in this repo would report it.
 *
 * Scanning source also catches the shape a type-level check cannot see at all:
 * an `_id` on a nested schema that is never exported on its own
 * (`artistStrikeSchema` was exactly that — reachable only as
 * `artistSchema.strikes[]`).
 */

const SRC = import.meta.dir;

function schemaFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

describe('the DTO wire contract', () => {
  /**
   * The vacuity floor. A traversal that silently stopped finding files would
   * make every assertion below pass on an empty set, which is the failure mode
   * a scanner-as-gate has to rule out before it is worth anything.
   */
  it('scans the whole package', () => {
    const files = schemaFiles();
    expect(files.length).toBeGreaterThanOrEqual(20);
    expect(files).toContain('artist.ts');
    expect(files).toContain('track.ts');
    expect(files).toContain('common.ts');
  });

  it('never declares `_id` on a DTO', () => {
    const offenders: string[] = [];

    for (const file of schemaFiles()) {
      const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Skip comment lines: `common.ts` and others discuss `_id` on purpose,
        // and a gate that cannot tell a declaration from a sentence about one
        // would force every explanation of this rule to be deleted to satisfy it.
        const code = line.split('//')[0] ?? '';
        if (/^\s*\*/.test(line)) return;
        if (/(^|[^a-zA-Z0-9_])_id\s*:/.test(code)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
