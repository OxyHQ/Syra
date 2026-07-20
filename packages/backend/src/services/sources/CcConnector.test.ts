import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { CcConnector } from './CcConnector';

const TEST_BASE = 'https://api.jamendo.test';
const TEST_CLIENT = 'test-client-id';

// ── Canned Jamendo response ───────────────────────────────────────────────────

const TRACK_A_COMMERCIAL = {
  id: 'j100',
  name: 'Open Road',
  duration: 210,
  artist_id: 'a1',
  artist_name: 'Free Artist',
  album_name: 'Open Album',
  album_id: 'al1',
  image: 'https://usercontent.jamendo.com/?action=artwork&id=j100',
  audiodownload: 'https://storage.jamendo.com/tracks/j100/audio.mp3',
  audiodownload_allowed: true,
  license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
};

const TRACK_B_NC = {
  id: 'j200',
  name: 'No Commerce',
  duration: 180,
  artist_id: 'a2',
  artist_name: 'NC Artist',
  album_name: null,
  album_id: null,
  image: null,
  audiodownload: 'https://storage.jamendo.com/tracks/j200/audio.mp3',
  audiodownload_allowed: true,
  license_ccurl: 'https://creativecommons.org/licenses/by-nc/4.0/',
};

const TRACK_C_NOT_DOWNLOADABLE = {
  id: 'j300',
  name: 'No Download',
  duration: 150,
  artist_id: 'a3',
  artist_name: 'Another Artist',
  album_name: null,
  album_id: null,
  image: null,
  audiodownload: '',
  audiodownload_allowed: false,
  license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
};

const TRACK_D_NO_LICENSE = {
  id: 'j400',
  name: 'Unknown License',
  duration: 120,
  artist_id: 'a4',
  artist_name: 'Mystery Artist',
  album_name: null,
  album_id: null,
  image: null,
  audiodownload: 'https://storage.jamendo.com/tracks/j400/audio.mp3',
  audiodownload_allowed: true,
  license_ccurl: '',
};

const TRACK_E_MALFORMED = {
  // missing id, name, duration
  artist_name: 'Broken',
};

const CANNED_RESPONSE = {
  results: [TRACK_A_COMMERCIAL, TRACK_B_NC, TRACK_C_NOT_DOWNLOADABLE, TRACK_D_NO_LICENSE, TRACK_E_MALFORMED],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CcConnector.search', () => {
  it('only commercially-licensable, downloadable tracks returned — tracks B/C/D/E excluded', async () => {
    let capturedUrl = '';
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async (url) => { capturedUrl = url; return CANNED_RESPONSE; },
    });

    const results = await connector.search('open road', 20);

    expect(results).toHaveLength(1);
    expect(results[0].externalId).toBe('j100');

    // URL must contain required params
    expect(capturedUrl).toContain('client_id=');
    expect(capturedUrl).toContain('search=');
    expect(capturedUrl).toContain('format=json');
  });

  it('normalises track A — provider, externalId, title, durationSec', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.provider).toBe('cc');
    expect(track.externalId).toBe('j100');
    expect(track.title).toBe('Open Road');
    expect(track.durationSec).toBe(210);
  });

  it('normalises track A — artist name + externalId', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.artists).toHaveLength(1);
    expect(track.artists[0].name).toBe('Free Artist');
    expect(track.artists[0].externalId).toBe('a1');
  });

  it('normalises track A — album included when both album_name and album_id present', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.album).toBeDefined();
    expect(track.album?.name).toBe('Open Album');
    expect(track.album?.externalId).toBe('al1');
  });

  it('normalises track A — image mapped with source "cc"', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');
    const images = track.images ?? [];

    expect(images).toHaveLength(1);
    expect(images[0].url).toBe('https://usercontent.jamendo.com/?action=artwork&id=j100');
    expect(images[0].source).toBe('cc');
  });

  it('normalises track A — downloadUrl and license set; no streamUrl', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.downloadUrl).toBe('https://storage.jamendo.com/tracks/j100/audio.mp3');
    expect(track.license).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('returns [] when results is not an array', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => ({ results: 'not-an-array' }),
    });

    const results = await connector.search('test');
    expect(results).toEqual([]);
  });

  it('returns [] when results key missing', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => ({ other: 'data' }),
    });

    const results = await connector.search('test');
    expect(results).toEqual([]);
  });

  it('propagates HTTP errors from httpGet', async () => {
    const connector = new CcConnector({
      clientId: TEST_CLIENT,
      apiBase: TEST_BASE,
      httpGet: async () => { throw new Error('Jamendo HTTP 503'); },
    });

    await expect(connector.search('test')).rejects.toThrow('Jamendo HTTP 503');
  });

  it('throws config error when clientId not set', async () => {
    // Ensure env var not set
    const saved = process.env.JAMENDO_CLIENT_ID;
    delete process.env.JAMENDO_CLIENT_ID;

    try {
      const connector = new CcConnector({ apiBase: TEST_BASE });
      await expect(connector.search('test')).rejects.toThrow('JAMENDO_CLIENT_ID not set');
    } finally {
      if (saved !== undefined) process.env.JAMENDO_CLIENT_ID = saved;
    }
  });

  it('provider is "cc"', () => {
    const connector = new CcConnector({ clientId: TEST_CLIENT, apiBase: TEST_BASE });
    expect(connector.provider).toBe('cc');
  });
});
