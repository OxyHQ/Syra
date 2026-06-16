import { resolveStream } from './streamService';
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

  it('resolves Audius stream and returns the resolution', async () => {
    const resolution = {
      url: 'https://audius.co/stream/abc123',
      type: 'audius' as const,
      expiresAt: null,
    };
    mockGet.mockResolvedValueOnce({ data: resolution });

    const result = await resolveStream('t2');

    expect(mockGet).toHaveBeenCalledWith('/stream/t2');
    expect(result).toEqual(resolution);
  });

  it('throws a descriptive error when api.get rejects', async () => {
    mockGet.mockRejectedValueOnce(new Error('Network error'));

    await expect(resolveStream('t3')).rejects.toThrow(
      'Failed to resolve stream for t3: Network error',
    );
  });

  it('throws a descriptive error for non-Error rejections', async () => {
    mockGet.mockRejectedValueOnce('timeout');

    await expect(resolveStream('t4')).rejects.toThrow(
      'Failed to resolve stream for t4: Unknown error',
    );
  });
});
