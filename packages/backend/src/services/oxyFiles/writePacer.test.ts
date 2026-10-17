import { describe, expect, it } from 'bun:test';
import { OxyWritePacer, retryAfterMs } from './writePacer';

/** A pacer on a fake clock: `sleep` advances it. */
function clocked(callsPerMinute = 20) {
  let now = 0;
  const waits: number[] = [];
  const pacer = new OxyWritePacer({
    callsPerMinute,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  return { pacer, waits, at: () => now };
}

const rateLimited = (details?: unknown) =>
  Object.assign(new Error('Too many'), { status: 429, ...(details ? { details } : {}) });

describe('OxyWritePacer', () => {
  it('spaces calls in a lane to the budget, and keeps lanes apart', async () => {
    // A frozen clock: each concurrent caller's wait is the slot it reserved.
    const waits: Array<[string, number]> = [];
    let lane = '';
    const pacer = new OxyWritePacer({
      callsPerMinute: 20,
      now: () => 0,
      sleep: async (ms) => {
        waits.push([lane, ms]);
      },
    });
    const call = (name: 'app' | 'user_media') => {
      lane = name;
      return pacer.call(name, async () => undefined);
    };
    await Promise.all([call('app'), call('app'), call('user_media'), call('app')]);
    expect(waits).toEqual([
      ['app', 3000],
      ['app', 6000],
    ]);
  });

  it('waits as long as a 429 says, then makes the SAME call again', async () => {
    const { pacer, at } = clocked();
    let attempts = 0;
    const result = await pacer.call('app', async () => {
      attempts += 1;
      if (attempts === 1) throw rateLimited({ retryAfterSeconds: 17 });
      return at();
    });
    expect(attempts).toBe(2);
    expect(result).toBe(17_000);
  });

  it('passes every other failure straight through', async () => {
    const { pacer } = clocked();
    const refused = Object.assign(new Error('nope'), { status: 415 });
    await expect(pacer.call('app', async () => Promise.reject(refused))).rejects.toBe(refused);
  });

  it('gives up on a lane that stays rate-limited', async () => {
    const { pacer } = clocked();
    let attempts = 0;
    await expect(
      pacer.call('app', async () => {
        attempts += 1;
        throw rateLimited();
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(30);
  });
});

describe('retryAfterMs', () => {
  it('reads the envelope, then the header, then falls back to the window', () => {
    expect(retryAfterMs({ details: { retryAfterSeconds: 5 } })).toBe(5000);
    expect(retryAfterMs({ response: { headers: { 'retry-after': '9' } } })).toBe(9000);
    expect(retryAfterMs({ response: { headers: new Headers({ 'retry-after': '3' }) } })).toBe(3000);
    expect(retryAfterMs(new Error('x'))).toBe(60_000);
  });
});
