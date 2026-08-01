import { uploadsService } from './uploadsService';
import { api } from '@/utils/api';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

// The multipart assembly is platform-split, and only the web branch can run
// under jsdom: the native branch appends a `{uri,name,type}` descriptor, which
// is a React Native extension that a spec-compliant `FormData` rejects. The
// error-recovery behaviour under test is identical on both.
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const audioFile = {
  uri: 'blob:local/a.mp3',
  name: 'a.mp3',
  mimeType: 'audio/mpeg',
  file: new File(['audio'], 'a.mp3', { type: 'audio/mpeg' }),
};

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;
const mockApiPost = api.post as jest.MockedFunction<typeof api.post>;

/**
 * The exact object `listUploadAlbums` builds in the uploads controller, key for
 * key. This is the point of the test: the album shape has NO counterpart in
 * `@syra/shared-types` — it exists only as that endpoint's response — so nothing
 * else makes the client's schema and the server's literal fail together when one
 * of them moves.
 */
const albumsResponse = {
  albums: [
    {
      albumKey: 'nadia ortiz|harbour lights|2023',
      albumName: 'Harbour Lights',
      albumArtistName: 'Nadia Ortiz',
      year: 2023,
      coverArt: '/api/images/6a34c2c5d1646e5174243590',
      trackCount: 12,
      totalDuration: 2431,
      trackIds: ['6a34c2c5d1646e517424358f', '6a34c2c5d1646e5174243592'],
    },
  ],
  total: 1,
};

describe('uploadsService.listUploadAlbums', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses the aggregation response and resolves cover art to a URL', async () => {
    mockApiGet.mockResolvedValueOnce({ data: albumsResponse });

    const result = await uploadsService.listUploadAlbums();

    expect(mockApiGet).toHaveBeenCalledWith('/uploads/albums');
    expect(result.total).toBe(1);
    expect(result.albums[0]).toMatchObject({
      albumKey: 'nadia ortiz|harbour lights|2023',
      albumName: 'Harbour Lights',
      albumArtistName: 'Nadia Ortiz',
      year: 2023,
      trackCount: 12,
      trackIds: ['6a34c2c5d1646e517424358f', '6a34c2c5d1646e5174243592'],
    });
    // A bare `/api/images/:id` reference is not renderable; every catalog read
    // runs it through the same resolver, and an album cover is no exception.
    expect(result.albums[0].coverArt).toMatch(/^https?:\/\//);
  });

  it('keeps a release whose optional fields the extractor could not fill', async () => {
    // An untitled release with no album artist and no year is a real locker
    // state — the file had an album tag and nothing else. Only `albumKey`,
    // `trackCount`, `totalDuration` and `trackIds` are guaranteed.
    mockApiGet.mockResolvedValueOnce({
      data: {
        albums: [
          {
            albumKey: '|untitled|',
            trackCount: 1,
            totalDuration: 200,
            trackIds: ['6a34c2c5d1646e517424358f'],
          },
        ],
        total: 1,
      },
    });

    const result = await uploadsService.listUploadAlbums();

    expect(result.albums[0].albumName).toBeUndefined();
    expect(result.albums[0].albumArtistName).toBeUndefined();
    expect(result.albums[0].coverArt).toBeUndefined();
  });

  it('rejects a response whose shape does not match the endpoint', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { albums: [{ albumKey: 'x' }], total: 1 } });

    await expect(uploadsService.listUploadAlbums()).rejects.toThrow('Invalid upload albums response');
  });
});

describe('uploadsService.createUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * The public path answers a refusal with 403/404/422 AND the `blocked` outcome
   * in the body, so the HTTP client throws on exactly the responses the uploader
   * most needs explained. Recovering the outcome is what turns a thrown error
   * back into the reason the file was refused.
   */
  it('recovers a blocked outcome from a rejected request rather than throwing', async () => {
    mockApiPost.mockRejectedValueOnce({
      status: 422,
      data: {
        outcome: 'blocked',
        code: 'artist_unresolved',
        message: 'No artist could be resolved from this file.',
        markers: [],
      },
    });

    const outcome = await uploadsService.createUpload(audioFile, { destination: 'public' });

    expect(outcome).toEqual({
      outcome: 'blocked',
      code: 'artist_unresolved',
      message: 'No artist could be resolved from this file.',
      markers: [],
    });
  });

  it('recovers a blocked outcome nested under response.data', async () => {
    mockApiPost.mockRejectedValueOnce({
      response: {
        status: 403,
        data: {
          outcome: 'blocked',
          code: 'contributor_blocked',
          message: 'This account cannot contribute.',
          markers: [],
        },
      },
    });

    const outcome = await uploadsService.createUpload(audioFile, { destination: 'public' });

    expect(outcome.outcome).toBe('blocked');
  });

  it('re-throws a genuine failure that carries no outcome', async () => {
    // A 500 with no outcome is not a refusal, and swallowing it as one would
    // report a server fault to the uploader as a decision about their file.
    mockApiPost.mockRejectedValueOnce(new Error('Network unavailable'));

    await expect(
      uploadsService.createUpload(audioFile, { destination: 'private' }),
    ).rejects.toThrow('Network unavailable');
  });
});
