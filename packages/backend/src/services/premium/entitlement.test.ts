import { describe, it, expect } from 'bun:test';
import { isPremium, getUserEntitlement } from './entitlement';

describe('isPremium', () => {
  it('true when user.premium.isPremium is true', () => {
    expect(isPremium({ premium: { isPremium: true } })).toBe(true);
  });

  it('false when user.premium.isPremium is false', () => {
    expect(isPremium({ premium: { isPremium: false } })).toBe(false);
  });

  it('false when user has no premium field', () => {
    expect(isPremium({})).toBe(false);
  });

  it('false when user is null', () => {
    expect(isPremium(null)).toBe(false);
  });

  it('false when user is undefined', () => {
    expect(isPremium(undefined)).toBe(false);
  });
});

describe('getUserEntitlement', () => {
  it('returns free when PREMIUM_USER_IDS is unset', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    delete process.env.PREMIUM_USER_IDS;
    try {
      const e = await getUserEntitlement('user-abc');
      expect(e.isPremium).toBe(false);
    } finally {
      if (saved !== undefined) process.env.PREMIUM_USER_IDS = saved;
    }
  });

  it('returns premium for a listed userId', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    process.env.PREMIUM_USER_IDS = 'u1, u2, u3';
    try {
      const e = await getUserEntitlement('u1');
      expect(e.isPremium).toBe(true);
    } finally {
      process.env.PREMIUM_USER_IDS = saved;
    }
  });

  it('is whitespace-tolerant (trims entries)', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    process.env.PREMIUM_USER_IDS = '  u1 , u2  ';
    try {
      const e = await getUserEntitlement('u2');
      expect(e.isPremium).toBe(true);
    } finally {
      process.env.PREMIUM_USER_IDS = saved;
    }
  });

  it('returns free for a userId not in the list', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    process.env.PREMIUM_USER_IDS = 'u1, u2';
    try {
      const e = await getUserEntitlement('u3');
      expect(e.isPremium).toBe(false);
    } finally {
      process.env.PREMIUM_USER_IDS = saved;
    }
  });

  it('ignores empty entries (e.g. trailing comma)', async () => {
    const saved = process.env.PREMIUM_USER_IDS;
    process.env.PREMIUM_USER_IDS = 'u1,';
    try {
      // Empty entry after trailing comma must not match arbitrary userId
      const e = await getUserEntitlement('');
      expect(e.isPremium).toBe(false);
    } finally {
      process.env.PREMIUM_USER_IDS = saved;
    }
  });
});
