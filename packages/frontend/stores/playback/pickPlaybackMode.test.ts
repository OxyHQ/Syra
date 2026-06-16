import { pickPlaybackMode } from './pickPlaybackMode';

describe('pickPlaybackMode', () => {
  it('audius → progressive (any platform)', () => {
    expect(pickPlaybackMode({ type: 'audius', isWeb: false, canPlayHlsNatively: false })).toBe('progressive');
    expect(pickPlaybackMode({ type: 'audius', isWeb: true, canPlayHlsNatively: true })).toBe('progressive');
    expect(pickPlaybackMode({ type: 'audius', isWeb: true, canPlayHlsNatively: false })).toBe('progressive');
  });

  it('hls + native (iOS/Android) → native', () => {
    expect(pickPlaybackMode({ type: 'hls', isWeb: false, canPlayHlsNatively: false })).toBe('native');
    expect(pickPlaybackMode({ type: 'hls', isWeb: false, canPlayHlsNatively: true })).toBe('native');
  });

  it('hls + web + Safari (canPlayHlsNatively=true) → native', () => {
    expect(pickPlaybackMode({ type: 'hls', isWeb: true, canPlayHlsNatively: true })).toBe('native');
  });

  it('hls + web + Chrome/Firefox (canPlayHlsNatively=false) → hlsjs', () => {
    expect(pickPlaybackMode({ type: 'hls', isWeb: true, canPlayHlsNatively: false })).toBe('hlsjs');
  });
});
