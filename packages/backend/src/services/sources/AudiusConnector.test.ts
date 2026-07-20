import { describe, it, expect } from 'bun:test';
import { AudiusConnector } from './AudiusConnector';

const TEST_BASE = 'https://discovery.test.audius.co';
const TEST_APP = 'Syra';

// ── Canned Audius response ────────────────────────────────────────────────────

const TRACK_A = {
  id: 'abc123',
  title: 'Good Vibes',
  duration: 185,
  is_delete: false,
  is_streamable: true,
  is_stream_gated: false,
  isrc: 'USABC1234567',
  genre: 'Electronic',
  mood: 'Energizing',
  tags: 'lofi,chill,beats',
  release_date: '2021-05-01T00:00:00Z',
  play_count: 12345,
  favorite_count: 678,
  repost_count: 90,
  user: {
    id: 'u1',
    name: 'DJ Test',
    profile_picture: {
      '150x150': 'https://cdn.audius.co/u1/150x150.jpg',
      '480x480': 'https://cdn.audius.co/u1/480x480.jpg',
      '1000x1000': 'https://cdn.audius.co/u1/1000x1000.jpg',
    },
  },
  artwork: {
    '150x150': 'https://cdn.audius.co/abc/150x150.jpg',
    '480x480': 'https://cdn.audius.co/abc/480x480.jpg',
    '1000x1000': 'https://cdn.audius.co/abc/1000x1000.jpg',
  },
};

const TRACK_B_GATED = {
  id: 'gated1',
  title: 'Gated Track',
  duration: 120,
  is_delete: false,
  is_streamable: true,
  is_stream_gated: true,
  user: { id: 'u2', name: 'Artist B' },
  artwork: null,
};

const TRACK_C_DELETED = {
  id: 'del1',
  title: 'Deleted Track',
  duration: 90,
  is_delete: true,
  is_streamable: true,
  is_stream_gated: false,
  user: { id: 'u3', name: 'Artist C' },
  artwork: null,
};

const TRACK_D_NOT_STREAMABLE = {
  id: 'ns1',
  title: 'Not Streamable',
  duration: 60,
  is_delete: false,
  is_streamable: false,
  is_stream_gated: false,
  user: { id: 'u4', name: 'Artist D' },
  artwork: null,
};

const CANNED_RESPONSE = {
  data: [TRACK_A, TRACK_B_GATED, TRACK_C_DELETED, TRACK_D_NOT_STREAMABLE],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AudiusConnector.search', () => {
  it('filters out gated / deleted / non-streamable — only track A returned', async () => {
    let capturedUrl = '';
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async (url) => { capturedUrl = url; return CANNED_RESPONSE; },
    });

    const results = await connector.search('good vibes', 20);

    expect(results).toHaveLength(1);
    expect(results[0].externalId).toBe('abc123');

    // URL must hit the right endpoint with required query params
    expect(capturedUrl).toContain('/v1/tracks/search');
    expect(capturedUrl).toContain('query=');
    expect(capturedUrl).toContain('app_name=Syra');
  });

  it('normalises track A — provider, externalId, title, durationSec', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.provider).toBe('audius');
    expect(track.externalId).toBe('abc123');
    expect(track.title).toBe('Good Vibes');
    expect(track.durationSec).toBe(185);
  });

  it('normalises track A — artist name + externalId', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.artists).toHaveLength(1);
    expect(track.artists[0].name).toBe('DJ Test');
    expect(track.artists[0].externalId).toBe('u1');
  });

  it('normalises track A — streamUrl contains /v1/tracks/<id>/stream and app_name', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.streamUrl).toContain('/v1/tracks/abc123/stream');
    expect(track.streamUrl).toContain('app_name=Syra');
  });

  it('normalises track A — images mapped largest-first with correct widths/heights', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');
    const images = track.images ?? [];

    expect(images.length).toBeGreaterThanOrEqual(2);

    // images[0] must be the largest size — firstImageUrl() picks this for display
    expect(images[0].width).toBe(1000);
    expect(images[0].url).toBe('https://cdn.audius.co/abc/1000x1000.jpg');

    // All three sizes present and in descending width order
    const largestWidth = images[0]?.width;
    const secondWidth = images[1]?.width;
    if (largestWidth === undefined || secondWidth === undefined) {
      throw new Error('expected the two largest images to carry widths');
    }
    expect(largestWidth).toBeGreaterThanOrEqual(secondWidth);

    const thirdWidth = images[2]?.width;
    if (thirdWidth !== undefined) {
      expect(secondWidth).toBeGreaterThanOrEqual(thirdWidth);
    }

    const img480 = images.find((i) => i.width === 480);
    expect(img480).toBeDefined();
    expect(img480?.url).toBe('https://cdn.audius.co/abc/480x480.jpg');
    expect(img480?.height).toBe(480);
    expect(img480?.source).toBe('audius');
  });

  it('normalises track A — isrc preserved', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');
    expect(track.isrc).toBe('USABC1234567');
  });

  it('returns [] when data is not an array (defensive parse)', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: 'not-an-array' }),
    });

    const results = await connector.search('test');
    expect(results).toEqual([]);
  });

  it('returns [] when data key is missing entirely', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ something: 'else' }),
    });

    const results = await connector.search('test');
    expect(results).toEqual([]);
  });

  it('propagates HTTP errors from httpGet', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => { throw new Error('Audius HTTP 503'); },
    });

    await expect(connector.search('test')).rejects.toThrow('Audius HTTP 503');
  });

  it('provider is "audius"', () => {
    const connector = new AudiusConnector({ apiBase: TEST_BASE, appName: TEST_APP });
    expect(connector.provider).toBe('audius');
  });

  it('maps user.profile_picture to artists[0].images when present', async () => {
    const trackWithProfilePic = {
      ...TRACK_A,
      user: {
        ...TRACK_A.user,
        profile_picture: {
          '150x150': 'https://cdn.audius.co/u1/150x150.jpg',
          '480x480': 'https://cdn.audius.co/u1/480x480.jpg',
          '1000x1000': 'https://cdn.audius.co/u1/1000x1000.jpg',
        },
      },
    };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [trackWithProfilePic] }),
    });

    const [track] = await connector.search('test');

    expect(track.artists).toHaveLength(1);
    const artistImages = track.artists[0].images ?? [];
    expect(artistImages.length).toBeGreaterThanOrEqual(2);

    // images[0] must be the largest (1000x1000) — same largest-first ordering as track artwork
    expect(artistImages[0].width).toBe(1000);
    expect(artistImages[0].url).toBe('https://cdn.audius.co/u1/1000x1000.jpg');
    expect(artistImages[0].source).toBe('audius');

    const img480 = artistImages.find((i) => i.width === 480);
    expect(img480).toBeDefined();
    expect(img480?.url).toBe('https://cdn.audius.co/u1/480x480.jpg');
    expect(img480?.source).toBe('audius');
  });

  it('skips tracks when user has no profile_picture', async () => {
    const trackNoProfilePic = {
      ...TRACK_A,
      user: { id: 'u1', name: 'DJ Test' }, // no profile_picture field
    };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [trackNoProfilePic] }),
    });

    const results = await connector.search('test');
    expect(results).toHaveLength(0);
  });

  it('skips tracks with blank title (empty string)', async () => {
    const blankTitleTrack = { ...TRACK_A, title: '' };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [blankTitleTrack] }),
    });

    const results = await connector.search('test');
    expect(results).toHaveLength(0);
  });

  it('skips tracks with whitespace-only title', async () => {
    const whitespaceTitleTrack = { ...TRACK_A, title: '   ' };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [whitespaceTitleTrack] }),
    });

    const results = await connector.search('test');
    expect(results).toHaveLength(0);
  });

  it('keeps valid tracks when mixed with blank-title tracks', async () => {
    const blankTitleTrack = { ...TRACK_A, id: 'blank1', title: '' };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [blankTitleTrack, TRACK_A] }),
    });

    const results = await connector.search('test');
    expect(results).toHaveLength(1);
    expect(results[0].externalId).toBe('abc123');
  });

  it('maps genre / mood / releaseDate from the track payload', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');

    expect(track.genre).toBe('Electronic');
    expect(track.mood).toBe('Energizing');
    expect(track.releaseDate).toBe('2021-05-01T00:00:00Z');
  });

  it('splits the comma-separated tags string into a trimmed array', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [{ ...TRACK_A, tags: ' lofi , chill ,, beats ' }] }),
    });

    const [track] = await connector.search('test');
    expect(track.tags).toEqual(['lofi', 'chill', 'beats']);
  });

  it('maps play/favorite/repost counts into popularity', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => CANNED_RESPONSE,
    });

    const [track] = await connector.search('test');
    expect(track.popularity?.playCount).toBe(12345);
    expect(track.popularity?.favoriteCount).toBe(678);
    expect(track.popularity?.repostCount).toBe(90);
  });

  it('normalises album metadata when a track payload includes it', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({
        data: [
          {
            ...TRACK_A,
            album: {
              id: 'album-track-1',
              playlist_name: 'Track Album',
              release_date: '2021-04-01T00:00:00Z',
              artwork: {
                '1000x1000': 'https://cdn.audius.co/album-track-1/1000x1000.jpg',
              },
            },
          },
        ],
      }),
    });

    const [track] = await connector.search('test');

    expect(track.album?.externalId).toBe('album-track-1');
    expect(track.album?.name).toBe('Track Album');
    expect(track.album?.trackExternalIds).toEqual(['abc123']);
    expect(track.album?.images?.[0].url).toBe('https://cdn.audius.co/album-track-1/1000x1000.jpg');
  });

  it('omits optional metadata fields when the payload lacks them', async () => {
    const minimal = {
      id: 'min1',
      title: 'Minimal',
      duration: 100,
      is_delete: false,
      is_streamable: true,
      is_stream_gated: false,
      user: {
        id: 'um',
        name: 'Min Artist',
        profile_picture: {
          '1000x1000': 'https://cdn.audius.co/um/1000x1000.jpg',
        },
      },
      artwork: {
        '1000x1000': 'https://cdn.audius.co/min1/1000x1000.jpg',
      },
    };
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: [minimal] }),
    });

    const [track] = await connector.search('test');
    expect(track.genre).toBeUndefined();
    expect(track.mood).toBeUndefined();
    expect(track.tags).toBeUndefined();
    expect(track.releaseDate).toBeUndefined();
    expect(track.popularity).toBeUndefined();
  });
});

// ── Album fetching ──────────────────────────────────────────────────────────

const ALBUM_A = {
  id: 'alb1',
  playlist_id: 53858,
  playlist_name: 'Pretty Little Liars',
  is_album: true,
  release_date: '2021-06-26T14:24:05Z',
  total_play_count: 589,
  repost_count: 1,
  favorite_count: 2,
  upc: null,
  artwork: {
    '150x150': 'https://cdn.audius.co/alb/150x150.jpg',
    '480x480': 'https://cdn.audius.co/alb/480x480.jpg',
    '1000x1000': 'https://cdn.audius.co/alb/1000x1000.jpg',
  },
};

describe('AudiusConnector.fetchArtistAlbums', () => {
  it('fetches albums for an artist and normalises core fields', async () => {
    const urls: string[] = [];
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async (url) => {
        urls.push(url);
        if (url.includes('/albums')) return { data: [ALBUM_A] };
        if (url.includes('/tracks')) return { data: [{ ...TRACK_A, genre: 'Hip-Hop/Rap' }] };
        return { data: [] };
      },
    });

    const albums = await connector.fetchArtistAlbums('artistX');

    expect(urls[0]).toContain('/v1/users/artistX/albums');
    expect(urls[0]).toContain('app_name=Syra');
    expect(albums).toHaveLength(1);

    const [album] = albums;
    expect(album.externalId).toBe('alb1');
    expect(album.name).toBe('Pretty Little Liars');
    expect(album.releaseDate).toBe('2021-06-26T14:24:05Z');
    expect(album.genre).toBe('Hip-Hop/Rap');
    expect(album.popularity?.playCount).toBe(589);
    expect(album.popularity?.favoriteCount).toBe(2);
    expect(album.popularity?.repostCount).toBe(1);
    // images mapped largest-first
    expect(album.images?.[0].width).toBe(1000);
    // member track external ids linked
    expect(album.trackExternalIds).toEqual(['abc123']);
    expect(album.tracks?.map((track) => track.externalId)).toEqual(['abc123']);
  });

  it('skips non-album playlists (is_album=false)', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async (url) => {
        if (url.includes('/albums')) {
          return { data: [{ ...ALBUM_A, is_album: false }] };
        }
        return { data: [] };
      },
    });

    const albums = await connector.fetchArtistAlbums('artistX');
    expect(albums).toHaveLength(0);
  });

  it('returns [] when the albums response is malformed', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async () => ({ data: 'nope' }),
    });

    const albums = await connector.fetchArtistAlbums('artistX');
    expect(albums).toEqual([]);
  });

  it('still returns the album when its track listing fetch fails', async () => {
    const connector = new AudiusConnector({
      apiBase: TEST_BASE,
      appName: TEST_APP,
      httpGet: async (url) => {
        if (url.includes('/albums')) return { data: [ALBUM_A] };
        if (url.includes('/tracks')) throw new Error('Audius HTTP 500');
        return { data: [] };
      },
    });

    const albums = await connector.fetchArtistAlbums('artistX');
    expect(albums).toHaveLength(1);
    expect(albums[0].trackExternalIds).toEqual([]);
  });
});
