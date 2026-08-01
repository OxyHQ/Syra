import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareFingerprints,
  fingerprintFile,
  parseFpcalcOutput,
  FINGERPRINT_MATCH_BER,
  FINGERPRINT_MAX_OFFSET_ITEMS,
  FINGERPRINT_MIN_OVERLAP_ITEMS,
} from './fingerprint';
import corpus from './__fixtures__/fingerprints.json';

/**
 * The committed corpus is REAL Chromaprint output — see `__fixtures__/generate.ts`
 * for exactly how it was produced. These tests recompute the numbers quoted in
 * the doc comment on {@link FINGERPRINT_MATCH_BER}, so the constant cannot drift
 * away from the evidence that justifies it: change the threshold and the
 * measurements that supported it fail here.
 */
const reference: number[] = corpus.reference;

/** Same recording, degraded the ways a re-upload actually is. */
const POSITIVES: ReadonlyArray<readonly [string, number[]]> = [
  ['re-encoded to 128 kbps MP3', corpus.mp3_128],
  ['re-encoded to 320 kbps MP3', corpus.mp3_320],
  ['re-encoded to 96 kbps AAC', corpus.aac96],
  ['halved volume', corpus.halfVolume],
  ['pink noise mixed in', corpus.pinkNoiseMixed],
  ['trimmed 1 s from the head', corpus.offset1s],
  ['time-stretched by 2 %', corpus.tempo2pct],
];

describe('compareFingerprints — the corpus behind the threshold', () => {
  it('the corpus is real and long enough to conclude anything', () => {
    // Vacuity floor: an empty or short corpus would make every assertion below
    // pass by abstention rather than by measurement.
    expect(reference.length).toBeGreaterThanOrEqual(FINGERPRINT_MIN_OVERLAP_ITEMS + 40);
    for (const [, values] of POSITIVES) {
      expect(values.length).toBeGreaterThanOrEqual(FINGERPRINT_MIN_OVERLAP_ITEMS);
    }
    expect(corpus.closestNegativeA.length).toBeGreaterThanOrEqual(FINGERPRINT_MIN_OVERLAP_ITEMS);
    expect(corpus.closestNegativeB.length).toBeGreaterThanOrEqual(FINGERPRINT_MIN_OVERLAP_ITEMS);
  });

  it('a fingerprint matches itself exactly', () => {
    const comparison = compareFingerprints(reference, reference);
    expect(comparison.matched).toBe(true);
    expect(comparison.bitErrorRate).toBe(0);
    expect(comparison.offset).toBe(0);
  });

  for (const [label, values] of POSITIVES) {
    it(`matches the same recording ${label}`, () => {
      const comparison = compareFingerprints(reference, values);
      expect(comparison.matched).toBe(true);
      if (comparison.bitErrorRate === undefined) throw new Error('expected a rate');
      // Every measured positive sits far below the threshold — the worst is the
      // 2 % time stretch at 0.0226.
      expect(comparison.bitErrorRate).toBeLessThan(0.03);
    });
  }

  it('finds the alignment for a trimmed head rather than comparing head-to-head', () => {
    const comparison = compareFingerprints(reference, corpus.offset1s);
    // 1.0 s at Chromaprint's ~8.08 items/s. This is the measurement the
    // items-per-second constant is derived from.
    expect(comparison.offset).toBe(8);
  });

  it('does NOT match the closest pair of unrelated recordings', () => {
    const comparison = compareFingerprints(corpus.closestNegativeA, corpus.closestNegativeB);
    expect(comparison.matched).toBe(false);
    if (comparison.bitErrorRate === undefined) throw new Error('expected a rate');
    expect(comparison.bitErrorRate).toBeGreaterThan(FINGERPRINT_MATCH_BER);
    // Measured 0.1638 — the margin the threshold is chosen against.
    expect(comparison.bitErrorRate).toBeGreaterThan(0.15);
  });

  it('keeps a real margin on both sides of the threshold', () => {
    const worstPositive = Math.max(
      ...POSITIVES.map(([, values]) => compareFingerprints(reference, values).bitErrorRate ?? 1),
    );
    const closestNegative =
      compareFingerprints(corpus.closestNegativeA, corpus.closestNegativeB).bitErrorRate ?? 0;

    expect(worstPositive).toBeLessThan(FINGERPRINT_MATCH_BER / 3);
    expect(closestNegative).toBeGreaterThan(FINGERPRINT_MATCH_BER * 1.5);
  });
});

describe('compareFingerprints — abstention', () => {
  /**
   * The measurement that decides {@link FINGERPRINT_MIN_OVERLAP_ITEMS}: over a
   * ~5 s window, two UNRELATED recordings from the corpus agree to within BER
   * 0.0023 — two orders of magnitude inside the match threshold, and better than
   * most genuine positives. Comparing short fingerprints does not weaken the
   * answer, it inverts it, so the comparator must refuse rather than guess.
   */
  it('a short window would produce a confident FALSE match, which is why it abstains', () => {
    const { items, startA, startB } = corpus.shortWindowFalseMatch;
    const shortA = corpus.shortWindowNegativeA.slice(startA, startA + items);
    const shortB = corpus.shortWindowNegativeB.slice(startB, startB + items);
    expect(shortA).toHaveLength(items);
    expect(shortB).toHaveLength(items);

    // Proof the danger is real, computed here with the same maths rather than
    // trusted from the JSON: over this ~5 s window two UNRELATED recordings agree
    // more closely than most genuine positives do.
    let differingBits = 0;
    for (let i = 0; i < shortA.length; i += 1) {
      let word = (shortA[i] ^ shortB[i]) >>> 0;
      while (word !== 0) {
        differingBits += word & 1;
        word >>>= 1;
      }
    }
    const shortWindowRate = differingBits / (shortA.length * 32);
    expect(shortWindowRate).toBeCloseTo(corpus.shortWindowFalseMatch.bitErrorRate, 5);
    expect(shortWindowRate).toBeLessThan(FINGERPRINT_MATCH_BER);

    // …and the guard that stops it being acted on.
    const comparison = compareFingerprints(shortA, shortB);
    expect(comparison.matched).toBe(false);
    expect(comparison.bitErrorRate).toBeUndefined();
    expect(comparison.alignedItems).toBeUndefined();
  });

  it('and the same two recordings do NOT match over a full-length comparison', () => {
    const comparison = compareFingerprints(
      corpus.shortWindowNegativeA,
      corpus.shortWindowNegativeB,
    );
    expect(comparison.matched).toBe(false);
    if (comparison.bitErrorRate === undefined) throw new Error('expected a rate');
    expect(comparison.bitErrorRate).toBeGreaterThan(FINGERPRINT_MATCH_BER);
  });

  it('abstains rather than reporting "no match" for an identical short pair', () => {
    const short = reference.slice(0, FINGERPRINT_MIN_OVERLAP_ITEMS - 1);
    const comparison = compareFingerprints(short, short);
    expect(comparison.matched).toBe(false);
    expect(comparison.bitErrorRate).toBeUndefined();
  });

  it('abstains on an empty fingerprint', () => {
    expect(compareFingerprints([], reference).matched).toBe(false);
    expect(compareFingerprints([], []).bitErrorRate).toBeUndefined();
  });

  it('never searches past the offset limit', () => {
    const shifted = reference.slice(FINGERPRINT_MAX_OFFSET_ITEMS + 30);
    const comparison = compareFingerprints(reference, shifted);
    if (comparison.offset !== undefined) {
      expect(Math.abs(comparison.offset)).toBeLessThanOrEqual(FINGERPRINT_MAX_OFFSET_ITEMS);
    }
  });
});

describe('parseFpcalcOutput', () => {
  /**
   * The unsigned-to-signed fold, tested against a crafted output rather than
   * against whatever the binary happens to produce.
   *
   * This is deliberately NOT asserted by running fpcalc: whether a real file
   * yields any top-bit-set value is content-dependent — the repeated fixture in
   * the suite below produces none — so a test that only ran the binary would
   * pass identically with the fold removed.
   */
  it('folds fpcalc\'s UNSIGNED decimals onto the signed int32 the model stores', () => {
    // Real fpcalc 1.5.1 output values, and the signed forms ffmpeg's chromaprint
    // muxer emits for the same audio.
    const parsed = parseFpcalcOutput(
      'DURATION=30\nFINGERPRINT=1701698039,3849189879,3849181687,3849312759,3849189751\n',
    );

    expect(parsed.durationSec).toBe(30);
    expect(parsed.values).toEqual([
      1701698039,
      -445777417,
      -445785609,
      -445654537,
      -445777545,
    ]);
    for (const value of parsed.values) {
      expect(value).toBeGreaterThanOrEqual(-2147483648);
      expect(value).toBeLessThanOrEqual(2147483647);
    }
  });

  it('accepts a build that already prints signed values', () => {
    const parsed = parseFpcalcOutput('DURATION=30\nFINGERPRINT=-445777417,1701698039\n');
    expect(parsed.values).toEqual([-445777417, 1701698039]);
  });

  it('rejects output with no fingerprint rather than returning an empty one', () => {
    expect(() => parseFpcalcOutput('DURATION=30\nFINGERPRINT=\n')).toThrow(/FINGERPRINT/);
    expect(() => parseFpcalcOutput('DURATION=30\n')).toThrow(/FINGERPRINT/);
  });

  it('rejects output with no usable duration', () => {
    expect(() => parseFpcalcOutput('FINGERPRINT=1,2,3\n')).toThrow(/DURATION/);
    expect(() => parseFpcalcOutput('DURATION=0\nFINGERPRINT=1,2,3\n')).toThrow(/DURATION/);
  });
});

describe('compareFingerprints — bit arithmetic', () => {
  it('counts every one of the 32 bits, including the sign bit', () => {
    // -1 is all ones; 0 is all zeros. Signed int32 is how MongoDB stores these,
    // so a popcount that lost the sign bit would silently under-report by 1/32.
    const allOnes = Array.from({ length: FINGERPRINT_MIN_OVERLAP_ITEMS }, () => -1);
    const allZeros = Array.from({ length: FINGERPRINT_MIN_OVERLAP_ITEMS }, () => 0);
    const comparison = compareFingerprints(allOnes, allZeros);
    expect(comparison.bitErrorRate).toBe(1);
    expect(comparison.matched).toBe(false);
  });

  it('treats the signed and unsigned spelling of a value as the same bits', () => {
    const signed = Array.from({ length: FINGERPRINT_MIN_OVERLAP_ITEMS }, () => -2147483648);
    const unsigned = Array.from({ length: FINGERPRINT_MIN_OVERLAP_ITEMS }, () => 2147483648 | 0);
    expect(compareFingerprints(signed, unsigned).bitErrorRate).toBe(0);
  });
});

// ── fpcalc, when it exists ──────────────────────────────────────────────────

/**
 * `fpcalc` ships in Alpine's `chromaprint` package, which the runtime image
 * installs, but it is absent from most development machines. These tests SKIP
 * with a visible message rather than passing vacuously — a green suite that
 * silently never executed the wrapper is exactly the check that cannot
 * distinguish success from failure.
 */
const fpcalcAvailable = spawnSync('fpcalc', ['-version']).error === undefined;
if (!fpcalcAvailable) {
  process.stderr.write(
    '[fingerprint.test] SKIPPING the fpcalc wrapper tests: `fpcalc` is not on PATH. ' +
      'Install Chromaprint (Alpine: `apk add chromaprint`, Debian: `apt install libchromaprint-tools`) to run them.\n',
  );
}

/**
 * Lengthen the committed WAV by repeating its PCM.
 *
 * The audio fixtures are 2.5 s, and Chromaprint emits NOTHING below ~2.6 s — its
 * 16-frame image filter costs about 21 items, so a fingerprint has
 * `duration × 8.08 − 21` values and that is zero or negative for a short clip.
 * Measured with fpcalc 1.5.1: 2.5 s → `ERROR: Empty fingerprint`, 3 s → 3 items,
 * 5 s → 19, 8 s → 43.
 *
 * Rather than commit a second, much larger audio fixture just for this, the WAV
 * is repeated in-process — a RIFF file is a header plus chunks, so this needs no
 * ffmpeg and works on any machine that can run the suite.
 */
function repeatWav(source: Buffer, times: number): Buffer {
  // Walk the chunk list rather than assuming a 44-byte header, so a writer that
  // emits an extra chunk cannot make this silently produce garbage.
  let offset = 12; // past 'RIFF' + size + 'WAVE'
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= source.length) {
    const id = source.toString('latin1', offset, offset + 4);
    const size = source.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error('fixture WAV has no data chunk');

  const pcm = source.subarray(dataStart, dataStart + dataLength);
  const repeated = Buffer.concat(Array.from({ length: times }, () => pcm));
  const header = Buffer.from(source.subarray(0, dataStart));
  header.writeUInt32LE(repeated.length, dataStart - 4); // data chunk size
  header.writeUInt32LE(dataStart - 8 + repeated.length, 4); // RIFF size
  return Buffer.concat([header, repeated]);
}

describe.if(fpcalcAvailable)('fingerprintFile — with fpcalc installed', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'syra-fpcalc-test-'));
  const longWav = path.join(workDir, 'long.wav');

  beforeAll(() => {
    // 12 × 2.5 s = 30 s, matching the corpus length.
    fs.writeFileSync(
      longWav,
      repeatWav(fs.readFileSync(path.join(__dirname, '__fixtures__', 'untagged.wav')), 12),
    );
  });
  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('fingerprints a real file', async () => {
    const result = await fingerprintFile(longWav);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    expect(result.durationSec).toBeGreaterThan(29);
    expect(result.durationSec).toBeLessThan(31);
    // duration × 8.08 − 21 ≈ 221 for 30 s.
    expect(result.values.length).toBeGreaterThan(200);
    expect(result.values.length).toBeLessThan(240);
    for (const value of result.values) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-2147483648);
      expect(value).toBeLessThanOrEqual(2147483647);
    }
  });

  it('is honest about a file too short to fingerprint', async () => {
    // 2.5 s: fpcalc exits non-zero with "Empty fingerprint". `failed` and not
    // `unavailable` — the binary is present, the FILE is the problem.
    const result = await fingerprintFile(path.join(__dirname, '__fixtures__', 'untagged.wav'));
    expect(result.status).toBe('failed');
  });

  it('reports a file it cannot decode as failed, not unavailable', async () => {
    const result = await fingerprintFile(path.join(__dirname, '__fixtures__', 'fingerprints.json'));
    expect(result.status).toBe('failed');
  });

  it('round-trips through the comparator', async () => {
    const result = await fingerprintFile(longWav);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    const comparison = compareFingerprints(result.values, result.values);
    expect(comparison.matched).toBe(true);
    expect(comparison.bitErrorRate).toBe(0);
  });
});

describe.if(!fpcalcAvailable)('fingerprintFile — without fpcalc installed', () => {
  it('reports `unavailable`, never a silent empty fingerprint', async () => {
    const result = await fingerprintFile(`${__dirname}/__fixtures__/indie-id3v2.mp3`);

    // The failure this guards against: returning `{ values: [] }`, which every
    // comparison reads as "no match" — a missing binary would then look exactly
    // like "we screened this file and it is original".
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toContain('fpcalc');
  });
});
