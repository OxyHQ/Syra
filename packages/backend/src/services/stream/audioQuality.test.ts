import { describe, it, expect } from 'bun:test';
import {
  bitrateForQuality,
  computeMaxBitrateKbps,
  BITRATE_BY_QUALITY,
  FREE_MAX_KBPS,
  DATASAVER_MAX_KBPS,
} from './audioQuality';
import type { AudioQuality } from '@syra/shared-types';

const FREE = { isPremium: false };
const PREMIUM = { isPremium: true };

describe('bitrateForQuality', () => {
  it('returns correct bitrate for each quality tier', () => {
    expect(bitrateForQuality('low')).toBe(BITRATE_BY_QUALITY.low);
    expect(bitrateForQuality('normal')).toBe(BITRATE_BY_QUALITY.normal);
    expect(bitrateForQuality('high')).toBe(BITRATE_BY_QUALITY.high);
    expect(bitrateForQuality('very_high')).toBe(BITRATE_BY_QUALITY.very_high);
  });

  it('low=96, normal=160, high=320, very_high=320', () => {
    expect(bitrateForQuality('low')).toBe(96);
    expect(bitrateForQuality('normal')).toBe(160);
    expect(bitrateForQuality('high')).toBe(320);
    expect(bitrateForQuality('very_high')).toBe(320);
  });
});

describe('computeMaxBitrateKbps', () => {
  it('premium + very_high → 320', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'very_high' }, PREMIUM)).toBe(320);
  });

  it('premium + high → 320', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'high' }, PREMIUM)).toBe(320);
  });

  it('premium + normal → 160', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'normal' }, PREMIUM)).toBe(160);
  });

  it('premium + low → 96', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'low' }, PREMIUM)).toBe(96);
  });

  it('free + very_high → capped at FREE_MAX_KBPS (160)', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'very_high' }, FREE)).toBe(FREE_MAX_KBPS);
  });

  it('free + high → capped at FREE_MAX_KBPS (160)', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'high' }, FREE)).toBe(FREE_MAX_KBPS);
  });

  it('free + normal → 160', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'normal' }, FREE)).toBe(160);
  });

  it('free + low → 96', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'low' }, FREE)).toBe(96);
  });

  it('dataSaver forces DATASAVER_MAX_KBPS (96) regardless of tier + quality', () => {
    expect(computeMaxBitrateKbps({ audioQuality: 'very_high', dataSaver: true }, PREMIUM)).toBe(DATASAVER_MAX_KBPS);
    expect(computeMaxBitrateKbps({ audioQuality: 'high', dataSaver: true }, PREMIUM)).toBe(DATASAVER_MAX_KBPS);
    expect(computeMaxBitrateKbps({ audioQuality: 'normal', dataSaver: true }, FREE)).toBe(DATASAVER_MAX_KBPS);
    expect(computeMaxBitrateKbps({ audioQuality: 'normal', dataSaver: true }, PREMIUM)).toBe(DATASAVER_MAX_KBPS);
  });

  it('no audioQuality defaults to normal (160 free, 160 premium)', () => {
    expect(computeMaxBitrateKbps({}, FREE)).toBe(160);
    expect(computeMaxBitrateKbps({}, PREMIUM)).toBe(160);
  });

  it('audioQuality undefined → treated as normal', () => {
    expect(computeMaxBitrateKbps({ audioQuality: undefined }, FREE)).toBe(160);
  });
});
