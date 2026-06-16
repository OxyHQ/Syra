import { describe, it, expect } from 'bun:test';
import { assertSafeAudioUrl, isLikelyAudio } from './safeAudioDownload';

// ── assertSafeAudioUrl ────────────────────────────────────────────────────────

describe('assertSafeAudioUrl — SSRF-blocked URLs must throw', () => {
  it('throws for http://localhost', () =>
    expect(() => assertSafeAudioUrl('http://localhost/x')).toThrow());

  it('throws for http://127.0.0.1', () =>
    expect(() => assertSafeAudioUrl('http://127.0.0.1/x')).toThrow());

  it('throws for EC2 metadata endpoint (169.254.169.254)', () =>
    expect(() => assertSafeAudioUrl('http://169.254.169.254/latest/meta-data/')).toThrow());

  it('throws for RFC-1918 10.x.x.x', () =>
    expect(() => assertSafeAudioUrl('http://10.0.0.5/x')).toThrow());

  it('throws for file:// protocol', () =>
    expect(() => assertSafeAudioUrl('file:///etc/passwd')).toThrow());

  it('throws for an over-2048-char URL', () =>
    expect(() => assertSafeAudioUrl('https://mp3d.jamendo.com/' + 'a'.repeat(2050))).toThrow());
});

describe('assertSafeAudioUrl — safe URLs must NOT throw', () => {
  it('does not throw for a real Jamendo mp32 URL', () =>
    expect(() =>
      assertSafeAudioUrl('https://mp3d.jamendo.com/download/track/123/mp32/'),
    ).not.toThrow());
});

// ── isLikelyAudio ─────────────────────────────────────────────────────────────

describe('isLikelyAudio — magic bytes / content-type', () => {
  it('returns true for a buffer starting with ID3 (MP3 with ID3 tag)', () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x00, 0x00, 0x00]); // 'ID3...'
    expect(isLikelyAudio(buf, null)).toBe(true);
  });

  it('returns true for MP3 frame sync bytes (0xFF 0xFB)', () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00]);
    expect(isLikelyAudio(buf, null)).toBe(true);
  });

  it('returns true for MP3 frame sync bytes (0xFF 0xE0 variant)', () => {
    // buffer[1] & 0xE0 === 0xE0 → must match
    const buf = Buffer.from([0xff, 0xe2, 0x00, 0x00]);
    expect(isLikelyAudio(buf, null)).toBe(true);
  });

  it('returns true when contentType is audio/mpeg (regardless of bytes)', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02]);
    expect(isLikelyAudio(buf, 'audio/mpeg')).toBe(true);
  });

  it('returns true when contentType is audio/mpeg with charset suffix', () => {
    const buf = Buffer.from([0x00]);
    expect(isLikelyAudio(buf, 'audio/mpeg; charset=utf-8')).toBe(true);
  });

  it('returns true for ftyp box at bytes 4..8 (mp4/m4a)', () => {
    // bytes: [0,0,0,20,'f','t','y','p','M','4','A',' ']
    const buf = Buffer.alloc(12, 0);
    buf.write('ftyp', 4, 'ascii');
    expect(isLikelyAudio(buf, null)).toBe(true);
  });

  it('returns false for text/html content type with HTML buffer', () => {
    const buf = Buffer.from('<!DOCTYPE html><html><body></body></html>');
    expect(isLikelyAudio(buf, 'text/html')).toBe(false);
  });

  it('returns false for empty buffer with application/json', () => {
    expect(isLikelyAudio(Buffer.alloc(0), 'application/json')).toBe(false);
  });

  it('returns false for garbage buffer with no content-type', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    expect(isLikelyAudio(buf, null)).toBe(false);
  });

  // octet-stream is generic — must NOT be trusted on MIME alone
  it('returns false for application/octet-stream + HTML bytes (octet-stream requires magic)', () => {
    const buf = Buffer.from('<!DOCTYPE html><html></html>');
    expect(isLikelyAudio(buf, 'application/octet-stream')).toBe(false);
  });

  it('returns true for application/octet-stream + ID3 magic bytes (magic wins)', () => {
    const buf = Buffer.from([0x49, 0x44, 0x33, 0x00, 0x00, 0x00]); // 'ID3...'
    expect(isLikelyAudio(buf, 'application/octet-stream')).toBe(true);
  });
});
