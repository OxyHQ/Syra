import { describe, it, expect } from 'bun:test';
import { encodeRadioCursor, decodeRadioCursor, RadioCursor } from './radioCursor';

const b64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('encodeRadioCursor / decodeRadioCursor', () => {
  it('round-trips a cursor', () => {
    const cursor: RadioCursor = { v: 1, seedType: 'track', seedId: 'track-123', page: 4 };
    expect(decodeRadioCursor(encodeRadioCursor(cursor))).toEqual(cursor);
  });

  it('round-trips every seed type, including the empty seedId of a user station', () => {
    const seedTypes = ['track', 'artist', 'album', 'playlist', 'genre', 'mood', 'user'] as const;
    for (const seedType of seedTypes) {
      const cursor: RadioCursor = { v: 1, seedType, seedId: '', page: 0 };
      expect(decodeRadioCursor(encodeRadioCursor(cursor))).toEqual(cursor);
    }
  });

  it('emits base64url — no padding or URL-unsafe characters', () => {
    const encoded = encodeRadioCursor({ v: 1, seedType: 'playlist', seedId: 'p?/+ab', page: 11 });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});

describe('decodeRadioCursor rejects bad input', () => {
  it('returns null for an empty string', () => {
    expect(decodeRadioCursor('')).toBeNull();
  });

  it('returns null for malformed base64', () => {
    expect(decodeRadioCursor('!!!not-base64!!!')).toBeNull();
  });

  it('returns null for base64 that is not JSON', () => {
    expect(decodeRadioCursor(Buffer.from('not json', 'utf8').toString('base64url'))).toBeNull();
  });

  it('returns null for JSON that is not an object', () => {
    expect(decodeRadioCursor(b64url('a string'))).toBeNull();
    expect(decodeRadioCursor(b64url(42))).toBeNull();
    expect(decodeRadioCursor(b64url(null))).toBeNull();
    expect(decodeRadioCursor(b64url([{ v: 1, seedType: 'track', seedId: 'a', page: 0 }]))).toBeNull();
  });

  it('returns null for a wrong version', () => {
    expect(decodeRadioCursor(b64url({ v: 2, seedType: 'track', seedId: 'a', page: 0 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: '1', seedType: 'track', seedId: 'a', page: 0 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ seedType: 'track', seedId: 'a', page: 0 }))).toBeNull();
  });

  it('returns null for a missing field', () => {
    expect(decodeRadioCursor(b64url({ v: 1, seedId: 'a', page: 0 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', page: 0 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 'a' }))).toBeNull();
  });

  it('returns null for an unknown seed type', () => {
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'podcast', seedId: 'a', page: 0 }))).toBeNull();
  });

  it('returns null for ill-typed fields', () => {
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 7, page: 0 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 'a', page: '0' }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 1, seedId: 'a', page: 0 }))).toBeNull();
  });

  it('returns null for a non-integer or negative page', () => {
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 'a', page: 1.5 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 'a', page: -1 }))).toBeNull();
    expect(decodeRadioCursor(b64url({ v: 1, seedType: 'track', seedId: 'a', page: NaN }))).toBeNull();
  });

  it('never throws on arbitrary junk', () => {
    const junk = ['%%%', 'e30', '~~~~', 'AAAA', 'eyJ2Ijox', '👋', ' '.repeat(50)];
    for (const raw of junk) {
      expect(() => decodeRadioCursor(raw)).not.toThrow();
    }
  });

  it('ignores extra fields rather than trusting them', () => {
    const decoded = decodeRadioCursor(
      b64url({ v: 1, seedType: 'artist', seedId: 'a1', page: 2, ownerKey: 'someone-else' })
    );
    expect(decoded).toEqual({ v: 1, seedType: 'artist', seedId: 'a1', page: 2 });
    expect(decoded).not.toHaveProperty('ownerKey');
  });
});
