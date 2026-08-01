/**
 * Chromaprint fingerprinting — `fpcalc` wrapper plus fingerprint comparison.
 *
 * A fingerprint is what catches the upload that has had every tag stripped: the
 * audio still matches the recording it was ripped from. It is the only screening
 * signal `provenanceSignals.ts` cannot provide, because it is the only one that
 * survives a determined tagger.
 *
 * `fpcalc` ships in Alpine's `chromaprint` package, which the runtime image
 * installs. It is NOT installed on every developer machine, and this module says
 * so out loud rather than pretending: {@link fingerprintFile} returns a
 * discriminated result whose `unavailable` arm callers must handle. Returning an
 * empty fingerprint would be far worse than returning nothing — an empty array
 * compares as "no match" against every catalog entry, so a missing binary would
 * read as "we checked and this is original", which is the exact failure a
 * screening step must never have.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

/** Chromaprint is fast, but a pathological input should not hang an upload. */
const FPCALC_TIMEOUT_MS = 60_000;
const EXEC_OPTS = { maxBuffer: 16 * 1024 * 1024, timeout: FPCALC_TIMEOUT_MS } as const;

// ── Results ─────────────────────────────────────────────────────────────────

export interface Fingerprint {
  /** Raw Chromaprint values as signed int32 — the form `TrackFingerprint` stores. */
  values: number[];
  /** Seconds of audio `fpcalc` read, which is what the candidate bucket keys on. */
  durationSec: number;
}

/**
 * `ok` — a fingerprint was computed.
 * `unavailable` — `fpcalc` is not installed. Not a file problem; the caller must
 *   decide (screen without the acoustic signal, or refuse to publish).
 * `failed` — `fpcalc` ran and rejected the file. That IS a file problem.
 */
export type FingerprintResult =
  | ({ status: 'ok' } & Fingerprint)
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; reason: string };

// ── fpcalc ──────────────────────────────────────────────────────────────────

/**
 * `fpcalc -raw` prints `DURATION=<seconds>` and `FINGERPRINT=<comma-separated>`.
 *
 * THE VALUES ARE UNSIGNED. fpcalc formats a `uint32_t`, so anything with the top
 * bit set arrives as a decimal above 2^31 — `3849189879`, not `-445777417`.
 * `TrackFingerprint` stores signed int32 and the comparator reads the bit
 * pattern, so `| 0` folds the two spellings onto the same value. Skipping the
 * fold would store numbers MongoDB cannot hold as `Int32` AND make the same
 * recording compare as a different one.
 *
 * Verified against fpcalc 1.5.1: its output for a 30 s file is item-for-item
 * identical to `ffmpeg -f chromaprint -algorithm 1 -fp_format raw` once folded,
 * which is what makes the ffmpeg-generated corpus in `__fixtures__` a valid
 * stand-in for fpcalc when measuring the threshold.
 *
 * Exported for testing: the unsigned-to-signed fold is content-dependent in
 * practice — plenty of real files produce no top-bit-set value at all — so a
 * test that only ran the binary could not tell a working fold from a missing one.
 */
export function parseFpcalcOutput(stdout: string): Fingerprint {
  let durationSec: number | undefined;
  let values: number[] | undefined;

  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toUpperCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'DURATION') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) durationSec = parsed;
    } else if (key === 'FINGERPRINT') {
      values = value
        .split(',')
        .filter((item) => item.length > 0)
        .map((item) => Number(item) | 0);
    }
  }

  if (!values || values.length === 0) {
    throw new Error('fpcalc produced no FINGERPRINT values');
  }
  if (durationSec === undefined || durationSec <= 0) {
    throw new Error('fpcalc produced no usable DURATION');
  }
  return { values, durationSec };
}

/**
 * Is this failure "the binary is missing" rather than "the file is bad"?
 *
 * Node reports a missing executable as `ENOENT` on the spawn itself. The message
 * check covers shells and wrappers that turn it into a 127 exit instead.
 */
function isMissingBinary(err: unknown): boolean {
  const code = (err as { code?: string | number }).code;
  if (code === 'ENOENT') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not found|ENOENT/i.test(message);
}

/**
 * Fingerprint a local audio file.
 *
 * Never throws for an environment problem — a missing `fpcalc` is a result, not
 * an exception, precisely so a caller cannot accidentally swallow it in a
 * `catch` and carry on as if the file had been screened.
 */
export async function fingerprintFile(filePath: string): Promise<FingerprintResult> {
  let stdout: string;
  try {
    const result = await execFile('fpcalc', ['-raw', filePath], EXEC_OPTS);
    stdout = result.stdout;
  } catch (err) {
    if (isMissingBinary(err)) {
      return {
        status: 'unavailable',
        reason:
          'fpcalc (Chromaprint) is not installed — acoustic screening was not performed. ' +
          'It ships in Alpine\'s `chromaprint` package, which the runtime image installs.',
      };
    }
    const stderr = (err as { stderr?: string }).stderr;
    return {
      status: 'failed',
      reason: `fpcalc failed for ${filePath}: ${stderr ?? String(err)}`,
    };
  }

  try {
    return { status: 'ok', ...parseFpcalcOutput(stdout) };
  } catch (err) {
    return {
      status: 'failed',
      reason: `fpcalc output for ${filePath} was unusable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

// ── Comparison ──────────────────────────────────────────────────────────────

/**
 * Below this bit error rate two fingerprints are the same recording.
 *
 * MEASURED, not guessed. `fpcalc` is absent from this development machine, so
 * the corpus was built with ffmpeg 7.1.5's `chromaprint` muxer
 * (`-f chromaprint -fp_format raw`), which links the SAME libchromaprint and was
 * run at `algorithm=1` — the TEST2 algorithm `fpcalc` also defaults to. The
 * committed vectors in `__fixtures__/fingerprints.json` are that corpus, and
 * `fingerprint.test.ts` recomputes these numbers on every run, so the constant
 * cannot drift away from the evidence that justifies it.
 *
 * Same recording (221-item fingerprints of 30 s of audio), degraded the ways a
 * re-upload actually is:
 *   re-encoded to 128 kbps MP3      BER 0.0000  (offset  0)
 *   re-encoded to 320 kbps MP3      BER 0.0000  (offset  0)
 *   re-encoded to 96 kbps AAC       BER 0.0010  (offset  0)
 *   halved volume                   BER 0.0000  (offset  0)
 *   pink noise mixed in at ¼ weight BER 0.0000  (offset  0)
 *   trimmed 1 s from the head       BER 0.0021  (offset +8)
 *   time-stretched by 2 %           BER 0.0226  (offset +3) — the worst positive
 *
 * Different recordings, 45 pairwise comparisons over a ten-piece corpus, using
 * this module's own alignment search (±40 items, ≥160 items of overlap):
 *   closest unrelated pair          BER 0.1638
 *
 * 0.10 sits ~4.4× above the worst positive and ~1.6× below the closest negative.
 * It also matches AcoustID's own convention of treating ≥90 % bit agreement as
 * the same recording, so a future move to their index needs no recalibration.
 *
 * The negative corpus is synthetic and deliberately self-similar (every piece is
 * a note sequence over a band-passed noise bed from one generator), which makes
 * its floor a PESSIMISTIC bound: two genuinely unrelated commercial recordings
 * sit far further apart than anything measured here.
 */
export const FINGERPRINT_MATCH_BER = 0.10;

/**
 * Chromaprint's frame rate: 11025 Hz / a 1365-sample hop ≈ 8.08 items per
 * second of SHIFT. Verified against the corpus — trimming exactly 1.0 s from the
 * head moved the best alignment by exactly 8 items.
 *
 * Not the same as the vector length per second: Chromaprint's 16-frame image
 * filter costs ~21 items overall, so 30 s of audio yields 221 items rather than
 * 242. Use this constant for offsets, never to predict a length.
 */
export const FINGERPRINT_ITEMS_PER_SECOND = 8.08;

/**
 * How far the alignment search shifts one fingerprint against the other: ±40
 * items ≈ ±5 s.
 *
 * Wide enough for the lead-in differences between two masters of one recording,
 * and deliberately no wider — every extra offset is another chance to draw a
 * lucky alignment. The measured negative floor below was found with the closest
 * pair sitting AT this boundary, which says the search is already as wide as the
 * margin can afford.
 */
export const FINGERPRINT_MAX_OFFSET_ITEMS = 40;

/**
 * Minimum aligned overlap before a comparison is allowed to conclude anything.
 *
 * This is the constant that actually prevents false positives, and it was NOT
 * obvious. Sliding-window measurements over the same ten-piece negative corpus,
 * printed by `__fixtures__/generate.ts` on every regeneration:
 *
 *   overlap  40 items (~5.0 s)   closest unrelated pair BER 0.0023
 *   overlap  80 items (~9.9 s)   closest unrelated pair BER 0.0891
 *   overlap 120 items (~14.9 s)  closest unrelated pair BER 0.1297
 *   overlap 160 items (~19.8 s)  closest unrelated pair BER 0.1539
 *   overlap 200 items (~24.8 s)  closest unrelated pair BER 0.1719
 *
 * At a 5 s window two unrelated recordings agreed to within BER 0.0023 — two
 * orders of magnitude INSIDE the match threshold, and better than most of the
 * genuine positives. An exhaustive search of every 40-item window in the corpus
 * found a pair agreeing to 0.0016, and THAT pair and window are committed to
 * `fingerprints.json` as `shortWindowNegativeA`/`B`, so `fingerprint.test.ts`
 * demonstrates the false match rather than only asserting the guard exists.
 *
 * A short window does not merely weaken the signal, it inverts the answer. 160
 * items (~20 s) is the first size with a full margin, and below it
 * {@link compareFingerprints} declines to answer rather than guess.
 *
 * The cost is real and accepted. A fingerprint has roughly
 * `duration × 8.08 − 21` items (the 16-frame image filter eats the difference),
 * so 160 items needs about 22.5 s of audio: shorter recordings cannot be matched
 * acoustically at all, tier 3 of the dedup chain abstains on them, and the fuzzy
 * tier decides instead. Below ~2.6 s Chromaprint produces nothing whatsoever —
 * fpcalc 1.5.1 exits with `ERROR: Empty fingerprint` (measured: 2.5 s → 0 items,
 * 3 s → 3, 5 s → 19, 8 s → 43), which {@link fingerprintFile} reports as
 * `failed` rather than `unavailable`, since the binary is fine and the file is
 * the problem.
 */
export const FINGERPRINT_MIN_OVERLAP_ITEMS = 160;

export interface FingerprintComparison {
  /**
   * Bit error rate over the best alignment, or `undefined` when the two
   * fingerprints never overlap by {@link FINGERPRINT_MIN_OVERLAP_ITEMS} items.
   * `undefined` means "cannot say", NOT "no match".
   */
  bitErrorRate?: number;
  /** Item offset of the best alignment: positive shifts `a` later than `b`. */
  offset?: number;
  /** How many items the best alignment compared. */
  alignedItems?: number;
  /** True only when a rate was computed AND it is below the threshold. */
  matched: boolean;
}

/** Population count of a 32-bit pattern (Hamming weight), branch-free. */
function popcount32(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  bits = (bits + (bits >>> 4)) & 0x0f0f0f0f;
  return (bits * 0x01010101) >>> 24;
}

function rateAtOffset(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
  offset: number,
): { bitErrorRate: number; alignedItems: number } | undefined {
  const aStart = offset >= 0 ? offset : 0;
  const bStart = offset >= 0 ? 0 : -offset;
  const alignedItems = Math.min(a.length - aStart, b.length - bStart);
  if (alignedItems < FINGERPRINT_MIN_OVERLAP_ITEMS) return undefined;

  let differingBits = 0;
  for (let i = 0; i < alignedItems; i += 1) {
    differingBits += popcount32((a[aStart + i] ^ b[bStart + i]) >>> 0);
  }
  return { bitErrorRate: differingBits / (alignedItems * 32), alignedItems };
}

/**
 * Compare two raw Chromaprint fingerprints by bit error rate over the best
 * alignment within {@link FINGERPRINT_MAX_OFFSET_ITEMS}.
 *
 * Returns `matched: false` with no rate when the fingerprints are too short to
 * overlap meaningfully — an honest abstention, because the alternative (compare
 * anyway over 5 s) demonstrably produces false matches.
 */
export function compareFingerprints(
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): FingerprintComparison {
  let best: { bitErrorRate: number; alignedItems: number; offset: number } | undefined;

  for (let offset = -FINGERPRINT_MAX_OFFSET_ITEMS; offset <= FINGERPRINT_MAX_OFFSET_ITEMS; offset += 1) {
    const rate = rateAtOffset(a, b, offset);
    if (!rate) continue;
    if (!best || rate.bitErrorRate < best.bitErrorRate) {
      best = { ...rate, offset };
    }
  }

  if (!best) return { matched: false };
  return {
    bitErrorRate: best.bitErrorRate,
    offset: best.offset,
    alignedItems: best.alignedItems,
    matched: best.bitErrorRate < FINGERPRINT_MATCH_BER,
  };
}
