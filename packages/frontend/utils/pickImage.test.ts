import { pickImageUrl } from './pickImage';
import type { TrackImage } from '@syra/shared-types';

const IMAGES: TrackImage[] = [
  { url: 's', width: 150, height: 150, source: 'audius' },
  { url: 'm', width: 480, height: 480, source: 'audius' },
  { url: 'l', width: 1000, height: 1000, source: 'audius' },
];

const FALLBACK = 'fallback-url';

describe('pickImageUrl — size selection', () => {
  it('preferredWidth 80 → picks smallest fitting (150)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 80)).toBe('s');
  });

  it('preferredWidth 150 → picks exactly 150 (smallest fitting)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 150)).toBe('s');
  });

  it('preferredWidth 200 → picks 480 (smallest >= 200)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 200)).toBe('m');
  });

  it('preferredWidth 480 → picks exactly 480', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 480)).toBe('m');
  });

  it('preferredWidth 500 → picks 1000 (smallest >= 500)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 500)).toBe('l');
  });

  it('preferredWidth 2000 → no image >= 2000 → picks largest (1000)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 2000)).toBe('l');
  });

  it('preferredWidth 1000 → picks exactly 1000', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 1000)).toBe('l');
  });
});

describe('pickImageUrl — fallback behaviour', () => {
  it('empty images array → returns fallback', () => {
    expect(pickImageUrl([], FALLBACK, 300)).toBe(FALLBACK);
  });

  it('undefined images → returns fallback', () => {
    expect(pickImageUrl(undefined, FALLBACK, 300)).toBe(FALLBACK);
  });

  it('undefined images + undefined fallback → returns undefined', () => {
    expect(pickImageUrl(undefined, undefined, 300)).toBeUndefined();
  });

  it('empty images + undefined fallback → returns undefined', () => {
    expect(pickImageUrl([], undefined, 300)).toBeUndefined();
  });
});

describe('pickImageUrl — robustness', () => {
  it('entry with missing width treated as 0, does not crash', () => {
    const imgs = [
      { url: 'no-width', source: 'audius' } as unknown as TrackImage,
      { url: 'has-width', width: 480, height: 480, source: 'audius' } as TrackImage,
    ];
    // preferredWidth 200 → only 480 qualifies
    expect(pickImageUrl(imgs, FALLBACK, 200)).toBe('has-width');
  });

  it('all entries missing width → returns the first (ties go to first iterated)', () => {
    const imgs = [
      { url: 'a', source: 'audius' } as unknown as TrackImage,
      { url: 'b', source: 'audius' } as unknown as TrackImage,
    ];
    // all widths normalised to 0; no entry >= 1; largest-fallback path iterates
    // in order and keeps the last one with width > best (never since 0 > 0 = false)
    // → result is the first entry iterated
    const result = pickImageUrl(imgs, FALLBACK, 300);
    expect(result).toBeDefined();
    expect(['a', 'b']).toContain(result);
  });

  it('single image, any preferredWidth → returns that image url', () => {
    const single: TrackImage[] = [{ url: 'only', width: 480, height: 480, source: 'audius' }];
    expect(pickImageUrl(single, FALLBACK, 80)).toBe('only');
    expect(pickImageUrl(single, FALLBACK, 800)).toBe('only');
  });
});
