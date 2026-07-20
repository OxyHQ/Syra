import { describe, expect, it } from '@jest/globals';
import { resolveCatalogImageUrl } from './catalogImages';

/**
 * `resolveCatalogImageUrl` is the studio's only catalog-art resolver, and it is
 * an allowlist: it accepts a bare ObjectId, a relative `/api/images/:id` path,
 * or an absolute URL that is already on the catalog API, and rejects everything
 * else. The rejection half is the part worth pinning — without it, any string
 * that reached this function would be handed straight to `expo-image` as a URL.
 *
 * With `EXPO_PUBLIC_API_URL` unset, `API_URL` falls back to
 * `http://localhost:3000/api`, so the expected origin here is localhost:3000.
 */

const ORIGIN = 'http://localhost:3000';
const OBJECT_ID = '507f1f77bcf86cd799439011';

describe('resolveCatalogImageUrl — accepted forms', () => {
  it('expands a bare ObjectId to an absolute catalog URL', () => {
    expect(resolveCatalogImageUrl(OBJECT_ID)).toBe(`${ORIGIN}/api/images/${OBJECT_ID}`);
  });

  it('accepts an uppercase-hex ObjectId', () => {
    const upper = 'ABCDEF123456789012345678';
    expect(resolveCatalogImageUrl(upper)).toBe(`${ORIGIN}/api/images/${upper}`);
  });

  it('makes a relative /api/images path absolute', () => {
    expect(resolveCatalogImageUrl(`/api/images/${OBJECT_ID}`)).toBe(
      `${ORIGIN}/api/images/${OBJECT_ID}`,
    );
  });

  it('passes through an absolute URL already on the catalog origin', () => {
    const absolute = `${ORIGIN}/api/images/${OBJECT_ID}`;
    expect(resolveCatalogImageUrl(absolute)).toBe(absolute);
  });

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveCatalogImageUrl(`  ${OBJECT_ID}  `)).toBe(`${ORIGIN}/api/images/${OBJECT_ID}`);
  });
});

describe('resolveCatalogImageUrl — rejected forms', () => {
  it('rejects an absolute URL on a foreign origin', () => {
    // The whole point of the origin check: a catalog record carrying an
    // attacker-controlled URL must not become a loaded image.
    expect(resolveCatalogImageUrl(`https://evil.example/api/images/${OBJECT_ID}`)).toBeUndefined();
  });

  it('rejects a URL on the catalog origin but outside the images path', () => {
    expect(resolveCatalogImageUrl(`${ORIGIN}/api/tracks/${OBJECT_ID}`)).toBeUndefined();
  });

  it('rejects strings that only resemble an ObjectId', () => {
    expect(resolveCatalogImageUrl('507f1f77bcf86cd79943901')).toBeUndefined();   // 23 chars
    expect(resolveCatalogImageUrl('507f1f77bcf86cd7994390111')).toBeUndefined(); // 25 chars
    expect(resolveCatalogImageUrl('zzzf1f77bcf86cd799439011')).toBeUndefined();  // non-hex
  });

  it('rejects empty and absent values', () => {
    expect(resolveCatalogImageUrl(undefined)).toBeUndefined();
    expect(resolveCatalogImageUrl(null)).toBeUndefined();
    expect(resolveCatalogImageUrl('')).toBeUndefined();
    expect(resolveCatalogImageUrl('   ')).toBeUndefined();
  });
});
