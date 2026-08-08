/**
 * `chunkForBindParams` — the arithmetic that decides whether a bulk import runs
 * at all.
 *
 * Worth its own tests because it is the one piece of this port with no observable
 * effect until the batch is large: every dump fixture in the two importer suites
 * is a handful of rows, so all of them fit in ONE statement and none can tell a
 * correct ceiling from no ceiling. The failure it prevents appears only against
 * a real MusicBrainz export, where the default `--batch-size 5000` asks for
 * 75001 parameters against a 65535 protocol limit.
 *
 * So the cases below sit exactly where a strict and a loose implementation
 * disagree: at the boundary, and one row either side of it.
 */

import { describe, expect, it } from 'bun:test';
import { chunkForBindParams } from './dumpImport';

/** The Bind message counts parameters in an Int16. */
const MAX_BIND_PARAMS = 65535;

function rows(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe('chunkForBindParams', () => {
  it('keeps a batch that fits in one statement as one statement', () => {
    expect(chunkForBindParams(rows(100), 8)).toHaveLength(1);
  });

  it('returns nothing for an empty batch rather than one empty statement', () => {
    // An empty chunk would be `insert … values ()`, a syntax error, and the
    // callers reach this with no URL rows whenever an artist has no links.
    expect(chunkForBindParams([], 5)).toEqual([]);
  });

  /**
   * The case the whole helper exists for: `musicbrainz_artists` at 15 parameters
   * per row and the shipped `--batch-size` default.
   */
  it('splits the 5000-row artist batch that would otherwise be rejected', () => {
    const chunks = chunkForBindParams(rows(5000), 15);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length * 15).toBeLessThanOrEqual(MAX_BIND_PARAMS);
    }
    // Splitting must not lose or duplicate a row.
    expect(chunks.flat()).toEqual(rows(5000));
  });

  it('leaves the 5000-row ISRC batch alone, which fits by arithmetic not by luck', () => {
    // 8 × 5000 = 40000. This is why only one of the two importers ever failed.
    expect(chunkForBindParams(rows(5000), 8)).toHaveLength(1);
  });

  /**
   * The boundary, from both sides.
   *
   * One parameter is reserved for the `updated_at` `$onUpdate` value drizzle
   * appends to the conflict `SET` clause once per statement. An implementation
   * that divided by `MAX_BIND_PARAMS` rather than `MAX_BIND_PARAMS - 1` passes
   * every other test in this file and produces a statement one parameter over
   * the limit on a full batch — which is a runtime error, on real data only.
   */
  it('reserves the one statement-level parameter at the exact boundary', () => {
    const perRow = 5;
    const exactly = Math.floor((MAX_BIND_PARAMS - 1) / perRow);

    expect(chunkForBindParams(rows(exactly), perRow)).toHaveLength(1);
    expect(chunkForBindParams(rows(exactly + 1), perRow)).toHaveLength(2);
    // The full statement, plus its reserved parameter, still fits.
    expect(exactly * perRow + 1).toBeLessThanOrEqual(MAX_BIND_PARAMS);
  });

  it('refuses a row too wide to send at all rather than emitting empty chunks', () => {
    // `Math.floor(65534 / 70000)` is 0, and a zero-sized step would loop forever.
    expect(() => chunkForBindParams(rows(1), MAX_BIND_PARAMS + 1)).toThrow(/exceeds/);
  });

  it('refuses a nonsensical parameter count', () => {
    expect(() => chunkForBindParams(rows(1), 0)).toThrow(/positive integer/);
    expect(() => chunkForBindParams(rows(1), -3)).toThrow(/positive integer/);
    expect(() => chunkForBindParams(rows(1), 1.5)).toThrow(/positive integer/);
  });
});
