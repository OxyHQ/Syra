import { entityService } from './entityService';

const mockGet = jest.fn();
const mockPublicGet = jest.fn();
jest.mock('@/utils/api', () => ({ api: { get: (...args: unknown[]) => mockGet(...args) }, publicApi: { get: (...args: unknown[]) => mockPublicGet(...args) } }));
jest.mock('@/utils/catalogImages', () => ({ normalizeAlbumImages: (value: unknown) => value, normalizePlaylistImages: (value: unknown) => value, normalizeTrackImages: (value: unknown) => value }));
afterEach(() => jest.clearAllMocks());
it('uses the linked client so viewer-readable playlist shelves retain the session', async () => {
  mockGet.mockResolvedValue({ data: { data: { id: 'artist', name: 'Artist', kind: 'artist', playlists: [] } } });
  expect(await entityService.getEntityProfile('artist')).toMatchObject({ id: 'artist' });
  expect(mockGet).toHaveBeenCalledWith('/p/artist');
  expect(mockPublicGet).not.toHaveBeenCalled();
});
