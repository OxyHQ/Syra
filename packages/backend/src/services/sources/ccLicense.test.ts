import { describe, it, expect } from 'bun:test';
import { permitsCommercialUse } from './ccLicense';

describe('permitsCommercialUse — allow set (commercial-use-permitted CC licenses)', () => {
  it('allows "by" (CC BY)', () => expect(permitsCommercialUse('by')).toBe(true));
  it('allows "by-sa" (CC BY-SA)', () => expect(permitsCommercialUse('by-sa')).toBe(true));
  it('allows "by-nd" (CC BY-ND)', () => expect(permitsCommercialUse('by-nd')).toBe(true));
  it('allows "cc0"', () => expect(permitsCommercialUse('cc0')).toBe(true));
  it('allows "publicdomain"', () => expect(permitsCommercialUse('publicdomain')).toBe(true));
  it('allows "CC BY 4.0" (full name)', () => expect(permitsCommercialUse('CC BY 4.0')).toBe(true));
  it('allows CC BY-SA URL', () =>
    expect(permitsCommercialUse('http://creativecommons.org/licenses/by-sa/4.0/')).toBe(true));
  it('allows CC0 / public domain URL', () =>
    expect(permitsCommercialUse('https://creativecommons.org/publicdomain/zero/1.0/')).toBe(true));
});

describe('permitsCommercialUse — reject set (NC or unknown)', () => {
  it('rejects "by-nc"', () => expect(permitsCommercialUse('by-nc')).toBe(false));
  it('rejects "by-nc-sa"', () => expect(permitsCommercialUse('by-nc-sa')).toBe(false));
  it('rejects "by-nc-nd"', () => expect(permitsCommercialUse('by-nc-nd')).toBe(false));
  it('rejects "CC BY-NC 4.0"', () => expect(permitsCommercialUse('CC BY-NC 4.0')).toBe(false));
  it('rejects CC BY-NC URL', () =>
    expect(permitsCommercialUse('http://creativecommons.org/licenses/by-nc/3.0/')).toBe(false));
  it('rejects "Creative Commons Attribution-NonCommercial"', () =>
    expect(permitsCommercialUse('Creative Commons Attribution-NonCommercial')).toBe(false));
  it('rejects undefined', () => expect(permitsCommercialUse(undefined)).toBe(false));
  it('rejects empty string', () => expect(permitsCommercialUse('')).toBe(false));
  it('rejects "all-rights-reserved"', () =>
    expect(permitsCommercialUse('all-rights-reserved')).toBe(false));
  it('rejects "proprietary"', () => expect(permitsCommercialUse('proprietary')).toBe(false));
  it('rejects an arbitrary unknown string', () =>
    expect(permitsCommercialUse('some-random-license')).toBe(false));
});

describe('permitsCommercialUse — NC detection is component-based, not naive substring', () => {
  // "sync" contains the letters n-c but is not a CC NonCommercial license.
  // It's unknown → must return false (not throw, not accidentally match allow set).
  it('"sync" (unknown, contains nc letters) → false (unknown licenses rejected)', () =>
    expect(permitsCommercialUse('sync')).toBe(false));
});
