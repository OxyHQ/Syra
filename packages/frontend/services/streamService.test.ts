import {
  clearStreamResolutionCache,
  prefetchStreams,
  resolveStream,
  resolveUploadStream,
} from './streamService';
import { api } from '@/utils/api';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
  },
}));

const mockGet = api.get as jest.MockedFunction<typeof api.get>;

describe('resolveStream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearStreamResolutionCache();
  });

  it('resolves HLS stream and returns the resolution', async () => {
    const resolution = {
      url: 'https://x/api/stream/t1/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2026-12-31T00:00:00.000Z',
    };
    mockGet.mockResolvedValueOnce({ data: resolution });

    const result = await resolveStream('t1');

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/stream/t1');
    expect(result).toEqual(resolution);
  });

  it('reuses a fresh cached stream resolution', async () => {
    const resolution = {
      url: 'https://x/api/stream/t1/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    mockGet.mockResolvedValueOnce({ data: resolution });

    await expect(resolveStream('t1')).resolves.toEqual(resolution);
    await expect(resolveStream('t1')).resolves.toEqual(resolution);

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent stream resolution requests', async () => {
    const resolution = {
      url: 'https://x/api/stream/t1/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    mockGet.mockResolvedValueOnce({ data: resolution });

    const [first, second] = await Promise.all([
      resolveStream('t1'),
      resolveStream('t1'),
    ]);

    expect(first).toEqual(resolution);
    expect(second).toEqual(resolution);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('prefetches unique refs without throwing to the caller', async () => {
    const resolution = {
      url: 'https://x/api/stream/t1/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    mockGet.mockResolvedValue({ data: resolution });

    prefetchStreams([
      { kind: 'track', id: 't1' },
      { kind: 'track', id: 't1' },
      { kind: 'track', id: 't2' },
      // Same id as the catalog track above: two collections, two keyspaces. A
      // ref-blind dedupe would drop this one as "already prefetched".
      { kind: 'upload', id: 't1' },
    ]);
    await Promise.resolve();

    expect(mockGet).toHaveBeenCalledTimes(3);
    expect(mockGet).toHaveBeenCalledWith('/stream/t1');
    expect(mockGet).toHaveBeenCalledWith('/stream/t2');
    expect(mockGet).toHaveBeenCalledWith('/uploads/t1/stream');
  });

  it('throws a descriptive error when api.get rejects', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));

    await expect(resolveStream('t3')).rejects.toThrow(
      'Failed to resolve stream for t3: Network error',
    );
  });

  it('throws a descriptive error for string rejections', async () => {
    mockGet.mockRejectedValueOnce('timeout');

    await expect(resolveStream('t4')).rejects.toThrow(
      'Failed to resolve stream for t4: timeout',
    );
  });

  it('throws the backend error message for HTTP-style rejections', async () => {
    mockGet.mockRejectedValueOnce({
      response: {
        status: 422,
        data: { error: 'Track not playable' },
      },
    });

    await expect(resolveStream('t5')).rejects.toThrow(
      'Failed to resolve stream for t5: Track not playable',
    );
  });
});

describe('resolveUploadStream', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearStreamResolutionCache();
  });

  it('resolves a locker file through the uploads endpoint', async () => {
    const resolution = {
      url: 'https://x/api/uploads/u1/stream/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    mockGet.mockResolvedValueOnce({ data: resolution });

    await expect(resolveUploadStream('u1')).resolves.toEqual(resolution);

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/uploads/u1/stream');
  });

  it('does not share cache entries with a catalog track of the same id', async () => {
    const catalogResolution = {
      url: 'https://x/api/stream/same/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    const uploadResolution = {
      url: 'https://x/api/uploads/same/stream/master.m3u8?t=tok',
      type: 'hls' as const,
      expiresAt: '2999-12-31T00:00:00.000Z',
    };
    mockGet
      .mockResolvedValueOnce({ data: catalogResolution })
      .mockResolvedValueOnce({ data: uploadResolution });

    await expect(resolveStream('same')).resolves.toEqual(catalogResolution);
    await expect(resolveUploadStream('same')).resolves.toEqual(uploadResolution);

    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});
