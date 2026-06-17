import { describe, it, expect } from 'bun:test';
import {
  playTasteWeight,
  countsAsGlobalPlay,
  deriveCompletion,
  PLAY_COMPLETION_THRESHOLD,
  SKIP_COMPLETION_THRESHOLD,
} from './engagement';

describe('deriveCompletion', () => {
  it('computes completion from listened/duration', () => {
    const r = deriveCompletion({ listenedSec: 90, durationSec: 180 });
    expect(r.completion).toBeCloseTo(0.5, 5);
    expect(r.skipped).toBe(false);
    expect(r.listenedSec).toBe(90);
  });

  it('clamps completion to [0,1]', () => {
    const over = deriveCompletion({ listenedSec: 400, durationSec: 180 });
    expect(over.completion).toBe(1);
  });

  it('marks a very short listen as a skip', () => {
    const r = deriveCompletion({ listenedSec: 5, durationSec: 200 });
    expect(r.completion).toBeLessThan(SKIP_COMPLETION_THRESHOLD);
    expect(r.skipped).toBe(true);
  });

  it('prefers an explicit completion ratio over duration math', () => {
    const r = deriveCompletion({ listenedSec: 10, durationSec: 200, explicitCompletion: 0.95 });
    expect(r.completion).toBeCloseTo(0.95, 5);
    expect(r.skipped).toBe(false);
  });

  it('treats a long listen with unknown duration as a moderate play, not a skip', () => {
    const r = deriveCompletion({ listenedSec: 45 });
    expect(r.completion).toBe(0.5);
    expect(r.skipped).toBe(false);
  });

  it('treats a short listen with unknown duration as a skip', () => {
    const r = deriveCompletion({ listenedSec: 10 });
    expect(r.completion).toBe(0);
    expect(r.skipped).toBe(true);
  });
});

describe('countsAsGlobalPlay', () => {
  it('counts a play at/above the completion threshold', () => {
    expect(countsAsGlobalPlay({ completion: PLAY_COMPLETION_THRESHOLD, skipped: false })).toBe(true);
  });

  it('does not count a skip even with high completion', () => {
    expect(countsAsGlobalPlay({ completion: 0.9, skipped: true })).toBe(false);
  });

  it('does not count a sub-threshold listen', () => {
    expect(countsAsGlobalPlay({ completion: 0.1, skipped: false })).toBe(false);
  });
});

describe('playTasteWeight', () => {
  it('returns a positive weight for an engaged play', () => {
    const w = playTasteWeight({ completion: 1, skipped: false, source: 'search' });
    expect(w).toBeGreaterThan(0);
  });

  it('weights a high-trust source above a low-trust one for the same completion', () => {
    const library = playTasteWeight({ completion: 1, skipped: false, source: 'library' });
    const radio = playTasteWeight({ completion: 1, skipped: false, source: 'radio' });
    expect(library).toBeGreaterThan(radio);
  });

  it('returns a negative weight for a skip', () => {
    const w = playTasteWeight({ completion: 0.05, skipped: true, source: 'search' });
    expect(w).toBeLessThan(0);
  });

  it('never exceeds the documented clamp', () => {
    const w = playTasteWeight({ completion: 1, skipped: false, source: 'library' });
    expect(w).toBeLessThanOrEqual(1.4);
  });
});
