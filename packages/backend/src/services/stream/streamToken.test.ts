import { describe, it, expect } from 'bun:test';
import jwt from 'jsonwebtoken';

// Set the secret before importing the module so process.env is populated
// at module-load time (jwt reads it at call time, but be explicit).
process.env.STREAM_TOKEN_SECRET = 'test-secret-for-unit-tests';

import { mintStreamToken, verifyStreamToken } from './streamToken';
import type { StreamTokenClaims } from './streamToken';

const CLAIMS: StreamTokenClaims = {
  trackId: 'track-abc',
  userId: 'user-xyz',
  maxBitrateKbps: 160,
};

describe('streamToken', () => {
  it('mint→verify roundtrip returns exact claims including maxBitrateKbps', () => {
    const token = mintStreamToken(CLAIMS);
    const result = verifyStreamToken(token);

    expect(result).not.toBeNull();
    expect(result?.trackId).toBe('track-abc');
    expect(result?.userId).toBe('user-xyz');
    expect(result?.maxBitrateKbps).toBe(160);
  });

  it('a tampered token returns null', () => {
    const token = mintStreamToken(CLAIMS);
    // Flip one character in the payload segment
    const parts = token.split('.');
    const flipped = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'a' ? 'b' : 'a');
    const tampered = [parts[0], flipped, parts[2]].join('.');

    expect(verifyStreamToken(tampered)).toBeNull();
  });

  it('an expired token (ttl=-1) returns null', () => {
    const token = mintStreamToken(CLAIMS, -1);
    expect(verifyStreamToken(token)).toBeNull();
  });

  it('a token signed with a different secret returns null', () => {
    const foreign = jwt.sign(
      { trackId: 'track-abc', userId: 'user-xyz', maxBitrateKbps: 160 },
      'other-secret',
      { expiresIn: 300 },
    );
    expect(verifyStreamToken(foreign)).toBeNull();
  });

  it('a malformed / garbage string returns null', () => {
    expect(verifyStreamToken('not.a.jwt')).toBeNull();
    expect(verifyStreamToken('')).toBeNull();
    expect(verifyStreamToken('garbage')).toBeNull();
  });

  it('verify with secret unset returns null', () => {
    const token = mintStreamToken(CLAIMS);
    const saved = process.env.STREAM_TOKEN_SECRET;
    delete process.env.STREAM_TOKEN_SECRET;
    try {
      expect(verifyStreamToken(token)).toBeNull();
    } finally {
      process.env.STREAM_TOKEN_SECRET = saved;
    }
  });

  it('mintStreamToken throws when secret is unset', () => {
    const saved = process.env.STREAM_TOKEN_SECRET;
    delete process.env.STREAM_TOKEN_SECRET;
    try {
      expect(() => mintStreamToken(CLAIMS)).toThrow('STREAM_TOKEN_SECRET not set');
    } finally {
      process.env.STREAM_TOKEN_SECRET = saved;
    }
  });

  it('a payload missing maxBitrateKbps returns null', () => {
    const secret = process.env.STREAM_TOKEN_SECRET as string;
    const noMax = jwt.sign({ trackId: 'track-abc', userId: 'user-xyz' }, secret, {
      expiresIn: 300,
    });
    expect(verifyStreamToken(noMax)).toBeNull();
  });

  it('a payload with non-number maxBitrateKbps returns null', () => {
    const secret = process.env.STREAM_TOKEN_SECRET as string;
    const badMax = jwt.sign(
      { trackId: 'track-abc', userId: 'user-xyz', maxBitrateKbps: 'high' },
      secret,
      { expiresIn: 300 },
    );
    expect(verifyStreamToken(badMax)).toBeNull();
  });
});
