import { File as DeviceFile } from 'expo-file-system';
import { sendAudioUpload } from '@syra.fm/sdk';
import { uploadAudioDirect } from './directAudioUpload';
import { api } from '@/utils/api';

jest.mock('@/utils/api', () => ({ api: { post: jest.fn() } }));
jest.mock('@syra.fm/sdk', () => ({ sendAudioUpload: jest.fn(async () => undefined) }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
// A device: the picker hands over a `file://` uri, not a DOM File.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const mockApiPost = api.post as jest.MockedFunction<typeof api.post>;
const MockDeviceFile = DeviceFile as unknown as jest.Mock;

const target = {
  uploadId: 'upload-2',
  url: 'https://syra-media.acct.r2.cloudflarestorage.com/incoming/episode/account/u/upload-2?X-Amz-Signature=s',
  method: 'PUT' as const,
  headers: { 'Content-Type': 'audio/mpeg' },
  maxBytes: 500 * 1024 * 1024,
  expiresAt: '2026-10-21T12:00:00.000Z',
};

describe('uploadAudioDirect on a device', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams the file from disk with the signed type, reporting progress', async () => {
    const upload = jest.fn(async (_url: string, options: { onProgress?: (p: unknown) => void }) => {
      options.onProgress?.({ bytesSent: 150, totalBytes: 300 });
      return { status: 200, body: '', headers: {} };
    });
    MockDeviceFile.mockImplementation(() => ({ size: 300 * 1024 * 1024, upload }));
    mockApiPost.mockResolvedValueOnce({ data: { data: target } });
    const progress: number[] = [];

    const reference = await uploadAudioDirect(
      'episode',
      { uri: 'file:///cache/ep.mp3', name: 'ep.mp3', mimeType: 'audio/mpeg' },
      (fraction) => progress.push(fraction),
    );

    expect(MockDeviceFile).toHaveBeenCalledWith('file:///cache/ep.mp3');
    // The size read from the file on disk is the one signed.
    expect(mockApiPost).toHaveBeenCalledWith('/audio-uploads', {
      purpose: 'episode',
      mimeType: 'audio/mpeg',
      sizeBytes: 300 * 1024 * 1024,
    });
    expect(upload).toHaveBeenCalledWith(
      target.url,
      expect.objectContaining({
        httpMethod: 'PUT',
        uploadType: 0,
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
    );
    expect(progress).toEqual([0.5, 1]);
    // Not read into JavaScript: the SDK's Blob path is for the web only.
    expect(sendAudioUpload).not.toHaveBeenCalled();
    expect(reference).toEqual({ uploadId: 'upload-2', fileName: 'ep.mp3' });
  });

  it('fails when storage refuses the PUT', async () => {
    MockDeviceFile.mockImplementation(() => ({
      size: 10,
      upload: jest.fn(async () => ({ status: 403, body: '', headers: {} })),
    }));
    mockApiPost.mockResolvedValueOnce({ data: { data: target } });

    await expect(
      uploadAudioDirect('track', { uri: 'file:///a.mp3', name: 'a.mp3', mimeType: 'audio/mpeg' }),
    ).rejects.toThrow('Upload to storage failed (403)');
  });
});
