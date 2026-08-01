import { describe, it, expect } from 'bun:test';
import { attributableImageSchema, imageLicenceSchema } from './track';

/**
 * The licence rules are a legal obligation expressed as a type. These tests
 * exist to prove the type actually refuses the shapes that would breach it —
 * an optional field everybody forgets looks identical to a required one until
 * something tries to omit it.
 */

const validLicence = {
  licence: 'CC-BY-SA-4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Jane Photographer',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
};

describe('imageLicenceSchema', () => {
  it('accepts a complete licence', () => {
    expect(imageLicenceSchema.safeParse(validLicence).success).toBe(true);
  });

  it('rejects a missing or empty attribution', () => {
    // CC BY-SA is discharged by NAMING the author; an empty string names nobody.
    expect(imageLicenceSchema.safeParse({ ...validLicence, attribution: undefined }).success).toBe(false);
    expect(imageLicenceSchema.safeParse({ ...validLicence, attribution: '' }).success).toBe(false);
  });

  it('rejects a missing licence identifier', () => {
    expect(imageLicenceSchema.safeParse({ ...validLicence, licence: undefined }).success).toBe(false);
  });

  it('rejects the raw Commons bytes host as the sourceUrl', () => {
    // A direct link to the bytes states neither the author nor the licence, so
    // it does not discharge attribution. This is the mistake people actually
    // make, because the raw URL is the one the API hands them.
    for (const sourceUrl of [
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Artist.jpg/800px-Artist.jpg',
      'http://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.PNG',
    ]) {
      const result = imageLicenceSchema.safeParse({ ...validLicence, sourceUrl });
      expect(result.success).toBe(false);
    }
  });

  it('does NOT reject a page URL merely for ending in an image extension', () => {
    // The Commons file page is named after the file, so it ends in `.jpg` too.
    // An extension-based rule would reject the CORRECT value and push whoever
    // hit it to supply the raw URL instead — failing in the worst direction.
    expect(
      imageLicenceSchema.safeParse({
        ...validLicence,
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
      }).success,
    ).toBe(true);
  });

  it('accepts a file/description page', () => {
    for (const sourceUrl of [
      'https://commons.wikimedia.org/wiki/File:Artist.jpg',
      'https://coverartarchive.org/release/76df3287-6cda-33eb-8e9a-044b5e15ffdd',
    ]) {
      expect(imageLicenceSchema.safeParse({ ...validLicence, sourceUrl }).success).toBe(true);
    }
  });
});

describe('attributableImageSchema', () => {
  it('lets an own-upload image carry no licence', () => {
    // Same provenance as the audio the uploader attested to — nobody to credit.
    const result = attributableImageSchema.safeParse({
      origin: 'upload',
      url: '/api/images/507f1f77bcf86cd799439011',
    });
    expect(result.success).toBe(true);
  });

  it('CANNOT construct an external image without a licence', () => {
    // The whole point of the discriminated union: "we will add the licence
    // later" is not a representable state.
    const result = attributableImageSchema.safeParse({
      origin: 'external',
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
      provider: 'wikimedia-commons',
    });
    expect(result.success).toBe(false);
  });

  it('CANNOT construct an external image without a provider', () => {
    const result = attributableImageSchema.safeParse({
      origin: 'external',
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
      licence: validLicence,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully attributed external image', () => {
    const result = attributableImageSchema.safeParse({
      origin: 'external',
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg',
      width: 1200,
      height: 1600,
      provider: 'wikimedia-commons',
      licence: validLicence,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown origin rather than defaulting to the unlicensed arm', () => {
    // Failing open here would mean a typo'd origin skips the licence check.
    expect(attributableImageSchema.safeParse({ origin: 'cc', url: 'https://x/y.jpg' }).success).toBe(false);
    expect(attributableImageSchema.safeParse({ url: 'https://x/y.jpg' }).success).toBe(false);
  });
});
