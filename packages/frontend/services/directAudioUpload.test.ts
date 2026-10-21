import { sendAudioUpload } from '@syra.fm/sdk';
import { uploadAudioDirect } from './directAudioUpload';
import { api } from '@/utils/api';

jest.mock('@/utils/api', () => ({ api: { post: jest.fn() } }));
jest.mock('@syra.fm/sdk', () => ({ sendAudioUpload: jest.fn(async () => undefined) }));
jest.mock('expo-file-system', () => ({ File: jest.fn(), UploadType: { BINARY_CONTENT: 0 } }));
// The web branch: the picked DOM File is what is sent.
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const mockApiPost = api.post as jest.MockedFunction<typeof api.post>;
const mockSend = sendAudioUpload as jest.MockedFunction<typeof sendAudioUpload>;

const target = {
  uploadId: 'upload-1',
  url: 'https://syra-media.acct.r2.cloudflarestorage.com/incoming/locker/account/u/upload-1?X-Amz-Signature=s',
  method: 'PUT' as const,
  headers: { 'Content-Type': 'audio/mpeg' },
  maxBytes: 200 * 1024 * 1024,
  expiresAt: '2026-10-21T12:00:00.000Z',
};

describe('uploadAudioDirect', () => {
  beforeEach(() => jest.clearAllMocks());

  it('asks for a presigned PUT of the exact size, sends the file with it, and returns the reference', async () => {
    mockApiPost.mockResolvedValueOnce({ data: { data: target } });
    const file = new File(['audio'], 'a.mp3', { type: 'audio/mpeg' });
    const onProgress = jest.fn();

    const reference = await uploadAudioDirect(
      'locker',
      { uri: 'blob:local/a.mp3', name: 'a.mp3', mimeType: 'audio/mpeg', file },
      onProgress,
    );

    // The exact size is signed: storage takes this length and no other.
    expect(mockApiPost).toHaveBeenCalledWith('/audio-uploads', {
      purpose: 'locker',
      mimeType: 'audio/mpeg',
      sizeBytes: file.size,
    });
    expect(mockSend).toHaveBeenCalledWith(target, file, { onProgress });
    expect(reference).toEqual({ uploadId: 'upload-1', fileName: 'a.mp3' });
  });

  it('refuses a form response it cannot read, before sending anything', async () => {
    mockApiPost.mockResolvedValueOnce({ data: { data: { uploadId: 'x' } } });

    await expect(
      uploadAudioDirect('track', {
        uri: 'blob:local/a.mp3',
        name: 'a.mp3',
        mimeType: 'audio/mpeg',
        file: new File(['a'], 'a.mp3'),
      }),
    ).rejects.toThrow('Invalid upload target response');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
