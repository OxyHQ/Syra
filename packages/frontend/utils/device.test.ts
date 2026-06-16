import { deviceTypeForPlatform, deviceDisplayName } from './device';

describe('deviceTypeForPlatform', () => {
  it('maps ios to mobile', () => {
    expect(deviceTypeForPlatform('ios')).toBe('mobile');
  });

  it('maps android to mobile', () => {
    expect(deviceTypeForPlatform('android')).toBe('mobile');
  });

  it('maps web to web', () => {
    expect(deviceTypeForPlatform('web')).toBe('web');
  });

  it('maps macos to desktop', () => {
    expect(deviceTypeForPlatform('macos')).toBe('desktop');
  });

  it('maps windows to desktop', () => {
    expect(deviceTypeForPlatform('windows')).toBe('desktop');
  });

  it('maps unknown os to web', () => {
    expect(deviceTypeForPlatform('unknown')).toBe('web');
  });

  it('maps empty string to web', () => {
    expect(deviceTypeForPlatform('')).toBe('web');
  });
});

describe('deviceDisplayName', () => {
  it('returns non-empty string for ios', () => {
    expect(deviceDisplayName('ios').length).toBeGreaterThan(0);
  });

  it('returns non-empty string for android', () => {
    expect(deviceDisplayName('android').length).toBeGreaterThan(0);
  });

  it('returns non-empty string for web', () => {
    expect(deviceDisplayName('web').length).toBeGreaterThan(0);
  });

  it('returns non-empty string for macos', () => {
    expect(deviceDisplayName('macos').length).toBeGreaterThan(0);
  });

  it('returns non-empty string for windows', () => {
    expect(deviceDisplayName('windows').length).toBeGreaterThan(0);
  });

  it('returns non-empty string for unknown', () => {
    expect(deviceDisplayName('unknown').length).toBeGreaterThan(0);
  });

  it('web returns "Web Player"', () => {
    expect(deviceDisplayName('web')).toBe('Web Player');
  });

  it('ios returns "iPhone"', () => {
    expect(deviceDisplayName('ios')).toBe('iPhone');
  });

  it('android returns "Android"', () => {
    expect(deviceDisplayName('android')).toBe('Android');
  });

  it('macos returns "Mac"', () => {
    expect(deviceDisplayName('macos')).toBe('Mac');
  });

  it('windows returns "Windows"', () => {
    expect(deviceDisplayName('windows')).toBe('Windows');
  });
});
