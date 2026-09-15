import { listenedBetween } from './listening-time';

describe('actual listening duration', () => {
  it('counts advancing audio, including a delayed background status update', () => {
    expect(listenedBetween({ position: 0, at: 0, playing: true }, { position: 60, at: 60000, playing: true })).toBe(60);
  });
  it('does not count seeking, rewinding, buffering or time spent paused', () => {
    const sample = { position: 10, at: 1000, playing: true };
    expect(listenedBetween(sample, { position: 90, at: 1500, playing: true })).toBe(0);
    expect(listenedBetween(sample, { position: 2, at: 1500, playing: true })).toBe(0);
    expect(listenedBetween(sample, { position: 10, at: 8000, playing: true })).toBe(0);
    expect(listenedBetween({ ...sample, playing: false }, { position: 20, at: 20000, playing: true })).toBe(0);
  });
  it('fails closed on invalid positions and backwards clocks', () => {
    expect(listenedBetween(null, { position: 1, at: 1000, playing: true })).toBe(0);
    expect(listenedBetween({ position: 0, at: 1000, playing: true }, { position: NaN, at: 0, playing: true })).toBe(0);
  });
});
