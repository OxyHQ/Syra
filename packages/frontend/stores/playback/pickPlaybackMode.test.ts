import { pickPlaybackMode } from './pickPlaybackMode';

describe('pickPlaybackMode', () => {
  it('hls + native (iOS/Android) → native', () => {
    expect(pickPlaybackMode({ isWeb: false, canPlayHlsNatively: false })).toBe('native');
    expect(pickPlaybackMode({ isWeb: false, canPlayHlsNatively: true })).toBe('native');
  });

  it('hls + web + Safari (canPlayHlsNatively=true) → native', () => {
    expect(pickPlaybackMode({ isWeb: true, canPlayHlsNatively: true })).toBe('native');
  });

  it('hls + web + Chrome/Firefox (canPlayHlsNatively=false) → hlsjs', () => {
    expect(pickPlaybackMode({ isWeb: true, canPlayHlsNatively: false })).toBe('hlsjs');
  });
});
