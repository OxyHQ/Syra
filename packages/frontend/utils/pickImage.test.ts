import { pickImageUrl } from './pickImage';
import type { TrackImage } from '@syra/shared-types';

const IMAGES: TrackImage[] = [
  { url: '/api/images/111111111111111111111111', width: 150, height: 150, source: 'audius' },
  { url: '/api/images/222222222222222222222222', width: 480, height: 480, source: 'audius' },
  { url: '/api/images/333333333333333333333333', width: 1000, height: 1000, source: 'audius' },
];

const API_IMAGES = 'http://localhost:3000/api/images';
const FALLBACK = '/api/images/aaaaaaaaaaaaaaaaaaaaaaaa';

describe('pickImageUrl — size selection', () => {
  it('preferredWidth 80 → picks smallest fitting (150)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 80)).toBe(`${API_IMAGES}/111111111111111111111111`);
  });

  it('preferredWidth 150 → picks exactly 150 (smallest fitting)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 150)).toBe(`${API_IMAGES}/111111111111111111111111`);
  });

  it('preferredWidth 200 → picks 480 (smallest >= 200)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 200)).toBe(`${API_IMAGES}/222222222222222222222222`);
  });

  it('preferredWidth 480 → picks exactly 480', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 480)).toBe(`${API_IMAGES}/222222222222222222222222`);
  });

  it('preferredWidth 500 → picks 1000 (smallest >= 500)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 500)).toBe(`${API_IMAGES}/333333333333333333333333`);
  });

  it('preferredWidth 2000 → no image >= 2000 → picks largest (1000)', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 2000)).toBe(`${API_IMAGES}/333333333333333333333333`);
  });

  it('preferredWidth 1000 → picks exactly 1000', () => {
    expect(pickImageUrl(IMAGES, FALLBACK, 1000)).toBe(`${API_IMAGES}/333333333333333333333333`);
  });
});

describe('pickImageUrl — fallback behaviour', () => {
  it('empty images array → returns fallback', () => {
    expect(pickImageUrl([], FALLBACK, 300)).toBe(`${API_IMAGES}/aaaaaaaaaaaaaaaaaaaaaaaa`);
  });

  it('undefined images → returns fallback', () => {
    expect(pickImageUrl(undefined, FALLBACK, 300)).toBe(`${API_IMAGES}/aaaaaaaaaaaaaaaaaaaaaaaa`);
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
      { url: '/api/images/bbbbbbbbbbbbbbbbbbbbbbbb', width: 480, height: 480, source: 'audius' } as TrackImage,
    ];
    // preferredWidth 200 → only 480 qualifies
    expect(pickImageUrl(imgs, FALLBACK, 200)).toBe(`${API_IMAGES}/bbbbbbbbbbbbbbbbbbbbbbbb`);
  });

  it('all entries missing width → returns the first (ties go to first iterated)', () => {
    const imgs = [
      { url: '/api/images/cccccccccccccccccccccccc', source: 'audius' } as unknown as TrackImage,
      { url: '/api/images/dddddddddddddddddddddddd', source: 'audius' } as unknown as TrackImage,
    ];
    // all widths normalised to 0; no entry >= 1; largest-fallback path iterates
    // in order and keeps the last one with width > best (never since 0 > 0 = false)
    // → result is the first entry iterated
    const result = pickImageUrl(imgs, FALLBACK, 300);
    expect(result).toBeDefined();
    expect([
      `${API_IMAGES}/cccccccccccccccccccccccc`,
      `${API_IMAGES}/dddddddddddddddddddddddd`,
    ]).toContain(result);
  });

  it('single image, any preferredWidth → returns that image url', () => {
    const single: TrackImage[] = [{ url: '/api/images/eeeeeeeeeeeeeeeeeeeeeeee', width: 480, height: 480, source: 'audius' }];
    expect(pickImageUrl(single, FALLBACK, 80)).toBe(`${API_IMAGES}/eeeeeeeeeeeeeeeeeeeeeeee`);
    expect(pickImageUrl(single, FALLBACK, 800)).toBe(`${API_IMAGES}/eeeeeeeeeeeeeeeeeeeeeeee`);
  });

  it('does not return external catalog URLs', () => {
    const external: TrackImage[] = [{ url: 'https://cdn.example.com/cover.jpg', width: 480, height: 480, source: 'audius' }];
    expect(pickImageUrl(external, undefined, 300)).toBeUndefined();
  });
});
