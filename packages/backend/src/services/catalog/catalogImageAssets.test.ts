import { describe, it, expect } from 'bun:test';
import { isWorthDownloadingAsImage } from './catalogImageAssets';

describe('isWorthDownloadingAsImage', () => {
  it('accepts any declared image/* type', () => {
    expect(isWorthDownloadingAsImage('image/jpeg')).toBe(true);
    expect(isWorthDownloadingAsImage('image/png')).toBe(true);
    expect(isWorthDownloadingAsImage('image/jpg')).toBe(true);
    expect(isWorthDownloadingAsImage('image/webp; charset=binary')).toBe(true);
  });

  it('accepts application/octet-stream and a missing header as ambiguous, worth sniffing', () => {
    // Measured directly: a real Anchor-hosted podbean episode-art bucket
    // serves its own show artwork as `image/jpg` but every per-episode
    // upload as `application/octet-stream` — both real, valid image bytes.
    // Rejecting on the header alone, as this used to, discarded every one.
    expect(isWorthDownloadingAsImage('application/octet-stream')).toBe(true);
    expect(isWorthDownloadingAsImage('')).toBe(true);
  });

  it('is case-insensitive and ignores a charset/boundary parameter', () => {
    expect(isWorthDownloadingAsImage('APPLICATION/OCTET-STREAM')).toBe(true);
    expect(isWorthDownloadingAsImage('application/octet-stream; charset=binary')).toBe(true);
    expect(isWorthDownloadingAsImage('  application/octet-stream  ')).toBe(true);
  });

  it('rejects a type that unambiguously is not image data', () => {
    expect(isWorthDownloadingAsImage('text/html')).toBe(false);
    expect(isWorthDownloadingAsImage('application/json')).toBe(false);
    expect(isWorthDownloadingAsImage('text/plain; charset=utf-8')).toBe(false);
  });
});
