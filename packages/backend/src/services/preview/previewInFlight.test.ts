/**
 * `ensurePreviewClip` in-flight de-duplication.
 *
 * `GET /api/preview/:trackId.mp3` takes no authentication and a cache MISS costs
 * an S3 download plus an ffmpeg transcode. Concurrent requests for the same clip
 * all observe `objectExists` as false — the first writer has not uploaded yet —
 * so without a shared promise each one pays that cost in full, and the multiplier
 * is chosen by whoever is calling.
 *
 * These count entries into the generation path rather than asserting on the
 * returned value, because the value is identical either way: the whole defect is
 * how many times the expensive work runs.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test';
import * as realS3 from '../s3Service';
import {
  ensurePreviewClip,
  resetPreviewGenerationStateForTests,
  type PreviewSourceRef,
} from './previewService';

const streamCalls: string[] = [];

// Spread the real module and override only the two functions under test — a
// wholesale replacement drops every other export and breaks unrelated importers
// of `s3Service` with a `SyntaxError` at import time.
//
// Patching AFTER the static import above is fine here for the same reason it is
// in `radio/radioStationStore.test.ts`: `previewService` calls these through the
// module binding inside each request, not once at module load.
mock.module('../s3Service', () => ({
  ...realS3,
  // The preview key is absent (that is the cache miss under test); the SOURCE
  // object is present, so the generation reaches the download.
  objectExists: async (key: string) => !key.includes('preview'),
  streamFromS3: async (key: string) => {
    streamCalls.push(key);
    // Fail AFTER counting: the count is the measurement, and rejecting here
    // keeps the test hermetic (no ffmpeg, no filesystem, no upload).
    throw new Error('stream unavailable');
  },
}));

afterEach(() => {
  streamCalls.length = 0;
  resetPreviewGenerationStateForTests();
});

const track: PreviewSourceRef = {
  id: '000000000000000000000001',
  artistId: '000000000000000000000002',
  albumId: '000000000000000000000003',
  title: 'Track',
  audioSource: { url: 'https://cdn.example/source.mp3', format: 'mp3' },
  hls: [],
};

describe('ensurePreviewClip — concurrent callers share one generation', () => {
  it('runs the expensive path ONCE for N concurrent requests on the same clip', async () => {
    const results = await Promise.allSettled([
      ensurePreviewClip(track, 0),
      ensurePreviewClip(track, 0),
      ensurePreviewClip(track, 0),
    ]);

    expect(streamCalls.length).toBe(1);
    // All three callers observe the same outcome — the joiners are not silently
    // handed a null while the leader does the work.
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('does NOT share between different start offsets — they are different clips', async () => {
    // The map is keyed on the preview key, not the track id. Keying on the track
    // would hand a caller asking for 0:30 the clip generated for 0:00.
    await Promise.allSettled([ensurePreviewClip(track, 0), ensurePreviewClip(track, 30)]);

    expect(streamCalls.length).toBe(2);
  });

  it('does not cache the failure — a later caller retries', async () => {
    // The entry is dropped in `finally`, so a transient S3 error must not become
    // a permanently dead clip for every subsequent request.
    await Promise.allSettled([ensurePreviewClip(track, 0)]);
    expect(streamCalls.length).toBe(1);

    await Promise.allSettled([ensurePreviewClip(track, 0)]);
    expect(streamCalls.length).toBe(2);
  });
});
