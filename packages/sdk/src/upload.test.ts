import { afterEach, describe, expect, it } from 'bun:test';
import { SyraApiError } from './errors';
import type { AudioUploadTarget } from './types';
import { audioMimeType, sendAudioUpload } from './upload';

const target: AudioUploadTarget = {
  uploadId: 'u',
  url: 'https://syra-media.acct.r2.cloudflarestorage.com/incoming/track/account/a/u?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'Content-Type': 'audio/mpeg' },
  maxBytes: 10,
  expiresAt: '2026-10-21T12:00:00.000Z',
};

/**
 * A stand-in `XMLHttpRequest` — what browsers and React Native have and Bun does
 * not — that reports upload progress in two steps and then answers `status`.
 */
function installFakeXhr(
  status: number,
  responseText = '',
): {
  sent: Blob[];
  requests: Array<{ method: string; url: string; headers: Record<string, string> }>;
} {
  const sent: Blob[] = [];
  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  class FakeXhr {
    status = 0;
    responseText = '';
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    open(method: string, url: string): void {
      requests.push({ method, url, headers: {} });
    }
    setRequestHeader(name: string, value: string): void {
      const request = requests[requests.length - 1];
      if (request) request.headers[name] = value;
    }
    abort(): void {
      this.onabort?.();
    }
    send(body: Blob): void {
      sent.push(body);
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 10,
          total: 10,
        } as ProgressEvent);
        this.status = status;
        this.responseText = responseText;
        this.onload?.();
      });
    }
  }
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  return { sent, requests };
}

afterEach(() => {
  delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
});

describe('sendAudioUpload', () => {
  it('reports progress as bytes leave, where the runtime can (XMLHttpRequest)', async () => {
    const { sent, requests } = installFakeXhr(200);
    const progress: number[] = [];
    const file = new Blob([new Uint8Array(10)], { type: 'audio/mpeg' });

    await sendAudioUpload(target, file, { onProgress: (fraction) => progress.push(fraction) });

    expect(progress).toEqual([0.5, 1, 1]);
    // The raw bytes, PUT to the presigned URL with exactly the signed type.
    expect(requests).toEqual([
      { method: 'PUT', url: target.url, headers: { 'Content-Type': 'audio/mpeg' } },
    ]);
    expect(sent).toEqual([file]);
  });

  it('names storage’s refusal rather than a bare status — here, a body of another size', async () => {
    installFakeXhr(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');

    const failure = await sendAudioUpload(
      target,
      new Blob([new Uint8Array(11)], { type: 'audio/mpeg' }),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyraApiError);
    expect((failure as SyraApiError).status).toBe(403);
    expect((failure as SyraApiError).message).toMatch(/size or type other than was signed/);
  });
});

describe('audioMimeType', () => {
  it('prefers the payload’s own type, then its name, then mp3', () => {
    expect(audioMimeType(new Blob([], { type: 'audio/wav' }), 'x.flac')).toBe('audio/wav');
    expect(audioMimeType({ uri: 'file:///a.m4a' }, 'a.m4a')).toBe('audio/mp4');
    expect(audioMimeType({ uri: 'file:///a', name: 'A.FLAC' })).toBe('audio/flac');
    expect(audioMimeType(new Blob([]))).toBe('audio/mpeg');
  });
});
