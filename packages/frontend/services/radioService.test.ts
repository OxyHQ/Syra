import { radioService } from './radioService';
import { api } from '@/utils/api';
import { getDeviceId } from '@/utils/deviceId';
import type { RadioStation, Track } from '@syra/shared-types';

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('@/utils/deviceId', () => ({
  getDeviceId: jest.fn(),
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;
const mockApiDelete = api.delete as jest.MockedFunction<typeof api.delete>;
const mockGetDeviceId = getDeviceId as jest.MockedFunction<typeof getDeviceId>;

const DEVICE_ID = 'a2f1c0de-0000-4000-8000-000000000001';

const track: Track = {
  id: 'track-1',
  title: 'Station Opener',
  artistId: 'artist-1',
  artistName: 'Artist One',
  duration: 180,
  isExplicit: false,
  isAvailable: true,
  source: 'upload',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const station: RadioStation = {
  seedType: 'track',
  seedId: 'track-1',
  title: 'Station Opener Radio',
  subtitle: 'Based on Station Opener',
  personalized: false,
  wrapped: false,
};

describe('radioService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeviceId.mockResolvedValue(DEVICE_ID);
  });

  it('reads a station page through the linked client, identified by device', async () => {
    mockApiGet.mockResolvedValueOnce({
      data: { station, tracks: [track], cursor: 'cursor-2', gate: null },
    });

    const page = await radioService.getPage({
      seedType: 'track',
      seedId: 'track-1',
      cursor: 'cursor-1',
      limit: 20,
    });

    expect(mockApiGet).toHaveBeenCalledWith(
      '/radio',
      { seedType: 'track', seedId: 'track-1', cursor: 'cursor-1', limit: 20 },
      { cache: false, headers: { 'X-Syra-Device-Id': DEVICE_ID } },
    );
    expect(page.station).toEqual(station);
    expect(page.tracks).toHaveLength(1);
    expect(page.cursor).toBe('cursor-2');
  });

  it('carries the guest preview gate through untouched', async () => {
    mockApiGet.mockResolvedValueOnce({
      data: {
        station,
        tracks: [track],
        cursor: null,
        gate: { reason: 'guest-preview-limit', previewSeconds: 30 },
      },
    });

    const page = await radioService.getPage({ seedType: 'track', seedId: 'track-1' });

    expect(page.gate).toEqual({ reason: 'guest-preview-limit', previewSeconds: 30 });
    expect(page.cursor).toBeNull();
  });

  it('rejects a malformed radio page at the API boundary', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { tracks: [track], cursor: null, gate: null } });

    await expect(radioService.getPage({ seedType: 'track', seedId: 'track-1' })).rejects.toThrow(
      'Invalid radio page response',
    );
  });

  it('rejects a page whose cursor is missing rather than null', async () => {
    mockApiGet.mockResolvedValueOnce({ data: { station, tracks: [track], gate: null } });

    await expect(radioService.getPage({ seedType: 'track', seedId: 'track-1' })).rejects.toThrow(
      'Invalid radio page response',
    );
  });

  it('resets a station by seed, identified by device', async () => {
    mockApiDelete.mockResolvedValueOnce({ data: undefined });

    await radioService.reset({ seedType: 'artist', seedId: 'artist-1' });

    expect(mockApiDelete).toHaveBeenCalledWith('/radio?seedType=artist&seedId=artist-1', {
      headers: { 'X-Syra-Device-Id': DEVICE_ID },
    });
  });
});
