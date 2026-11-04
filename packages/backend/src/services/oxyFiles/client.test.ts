import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readOxyFile, setOxyFilesForTests, type OxyFilesApi } from './client';

/**
 * `readOxyFile` against a real HTTP server standing in for Oxy's CDN: the byte
 * cap is enforced while the body streams, so a body with no declared length
 * cannot be buffered whole before it is refused.
 */
const CAP = 40 * 1024 * 1024;
const CHUNK = new Uint8Array(1024 * 1024);

let cdn: ReturnType<typeof Bun.serve>;
let chunksServed = 0;

beforeAll(() => {
  cdn = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const id = new URL(request.url).pathname.slice(1);
      if (id === 'small') return new Response('image-bytes');
      if (id === 'missing') return new Response('gone', { status: 404 });
      // `oversized`: chunked, no Content-Length, one MiB at a time, forever.
      chunksServed = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            chunksServed += 1;
            controller.enqueue(CHUNK);
          },
        }),
      );
    },
  });
  setOxyFilesForTests({
    publicUrl: (fileId: string) => `${cdn.url.origin}/${fileId}`,
  } as unknown as OxyFilesApi);
});
afterEach(() => {
  chunksServed = 0;
});
afterAll(() => {
  setOxyFilesForTests(null);
  cdn.stop(true);
});

describe('readOxyFile', () => {
  it('returns the bytes of a public file', async () => {
    expect((await readOxyFile('small')).toString()).toBe('image-bytes');
  });

  it('refuses a non-2xx answer', async () => {
    await expect(readOxyFile('missing')).rejects.toThrow('status 404');
  });

  it('stops an undeclared body at the cap instead of reading it all', async () => {
    await expect(readOxyFile('oversized')).rejects.toThrow('too large');
    // The stream is endless: reaching the assertion at all means the read was
    // abandoned near the cap, not after buffering whatever the server sent.
    expect(chunksServed * CHUNK.length).toBeLessThan(CAP + 16 * CHUNK.length);
  });
});
