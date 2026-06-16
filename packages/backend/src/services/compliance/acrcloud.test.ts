import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  isAcrCloudConfigured,
  fingerprintAudio,
  screenBeforePublish,
} from './acrcloud';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ENV_KEYS = ['ACRCLOUD_HOST', 'ACRCLOUD_ACCESS_KEY', 'ACRCLOUD_ACCESS_SECRET'] as const;

function clearAcrEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function setAcrEnv(): void {
  process.env.ACRCLOUD_HOST = 'identify-eu-west-1.acrcloud.com';
  process.env.ACRCLOUD_ACCESS_KEY = 'test-access-key';
  process.env.ACRCLOUD_ACCESS_SECRET = 'test-access-secret';
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => clearAcrEnv());
afterEach(() => clearAcrEnv());

// ── isAcrCloudConfigured ──────────────────────────────────────────────────────

describe('isAcrCloudConfigured', () => {
  it('returns false when all env vars unset', () => {
    expect(isAcrCloudConfigured()).toBe(false);
  });

  it('returns false when only ACRCLOUD_HOST is set', () => {
    process.env.ACRCLOUD_HOST = 'identify-eu-west-1.acrcloud.com';
    expect(isAcrCloudConfigured()).toBe(false);
  });

  it('returns false when only two of three env vars are set', () => {
    process.env.ACRCLOUD_HOST = 'identify-eu-west-1.acrcloud.com';
    process.env.ACRCLOUD_ACCESS_KEY = 'test-key';
    expect(isAcrCloudConfigured()).toBe(false);
  });

  it('returns true when all three env vars are set', () => {
    setAcrEnv();
    expect(isAcrCloudConfigured()).toBe(true);
  });
});

// ── fingerprintAudio ──────────────────────────────────────────────────────────

describe('fingerprintAudio', () => {
  it('returns { matched: false } when unconfigured — no network I/O', async () => {
    const result = await fingerprintAudio(Buffer.alloc(1024));
    expect(result).toEqual({ matched: false });
  });

  it('returns { matched: false } when configured (stub — no real call)', async () => {
    setAcrEnv();
    const result = await fingerprintAudio(Buffer.alloc(1024));
    // Stub returns { matched: false } even when configured; real call is future work
    expect(result.matched).toBe(false);
  });
});

// ── screenBeforePublish ───────────────────────────────────────────────────────

describe('screenBeforePublish', () => {
  it('allows upload when unconfigured', async () => {
    const result = await screenBeforePublish(Buffer.alloc(1024));
    expect(result).toEqual({ allow: true });
  });

  it('allows upload when configured (stub — no match)', async () => {
    setAcrEnv();
    const result = await screenBeforePublish(Buffer.alloc(1024));
    expect(result.allow).toBe(true);
    expect(result.match).toBeUndefined();
  });
});
