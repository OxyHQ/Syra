import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import mongoose from 'mongoose';
import { connect, clear, disconnect } from '../../test/mongo';
import { TrackModel } from '../../models/Track';
import { ingestTrack } from './ingestTrack';
import type { PackageResult } from './hlsPackager';
import type { StoredHls } from './hlsStorage';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Shared fakes ─────────────────────────────────────────────────────────────

const ARTIST_ID = new mongoose.Types.ObjectId().toString();

const CANNED_PACKAGE_RESULT: PackageResult = {
  outputDir: '/tmp/fake-output',
  masterPlaylistPath: 'master.m3u8',
  renditions: [
    { bitrateKbps: 96, playlistPath: '96/stream.m3u8' },
    { bitrateKbps: 160, playlistPath: '160/stream.m3u8' },
    { bitrateKbps: 320, playlistPath: '320/stream.m3u8' },
  ],
  keyHex: 'deadbeefdeadbeefdeadbeefdeadbeef',
  keyUri: '/api/stream/fake-track-id/key',
  loudnessLufs: -12.3,
};

const CANNED_STORED: StoredHls = {
  hls: [
    { manifestKey: 'hls/a/t/96/stream.m3u8', bitrateKbps: 96, encrypted: true },
    { manifestKey: 'hls/a/t/160/stream.m3u8', bitrateKbps: 160, encrypted: true },
    { manifestKey: 'hls/a/t/320/stream.m3u8', bitrateKbps: 320, encrypted: true },
  ],
  hlsMasterKey: 'hls/a/t/master.m3u8',
};

const happyDeps = {
  fetchSource: async () => ({ localPath: '/tmp/fake.mp3', cleanup: () => {} }),
  packageHls: async () => CANNED_PACKAGE_RESULT,
  storeHls: async () => CANNED_STORED,
  generatePreview: async () => 'previews/fake-track-id/0.mp3',
};

async function createTrack(overrides: Record<string, unknown> = {}) {
  return TrackModel.create({
    title: 'Test Track',
    artistId: ARTIST_ID,
    artistName: 'Test Artist',
    duration: 180,
    source: 'upload',
    status: 'processing',
    isExplicit: false,
    isAvailable: true,
    audioSource: { url: '/api/audio/fake', format: 'mp3' },
    ...overrides,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ingestTrack', () => {
  it('happy path: status → ready, hls/hlsMasterKey/loudnessLufs written', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    await ingestTrack(trackId, happyDeps);

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('ready');
    expect(reloaded?.loudnessLufs).toBe(-12.3);
    expect(reloaded?.hlsMasterKey).toBe('hls/a/t/master.m3u8');
    expect(reloaded?.hls).toHaveLength(3);
    expect(reloaded?.hls?.[0].manifestKey).toBe('hls/a/t/96/stream.m3u8');
    expect(reloaded?.hls?.[0].encrypted).toBe(true);
  });

  it('best-effort preview: generatePreview throwing does not fail ingest', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    const previewFailDeps = {
      ...happyDeps,
      generatePreview: async (): Promise<string> => {
        throw new Error('ffmpeg preview clip failed');
      },
    };

    await ingestTrack(trackId, previewFailDeps);

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('ready');
  });

  it('failure path: packageHls throws → status set to failed, error rethrown', async () => {
    const track = await createTrack();
    const trackId = track._id.toString();

    const failDeps = {
      ...happyDeps,
      packageHls: async (): Promise<PackageResult> => {
        throw new Error('ffmpeg exploded');
      },
    };

    await expect(ingestTrack(trackId, failDeps)).rejects.toThrow('ffmpeg exploded');

    const reloaded = await TrackModel.findById(trackId);
    expect(reloaded?.status).toBe('failed');
  });

  it('missing track: rejects with clear error', async () => {
    const absentId = new mongoose.Types.ObjectId().toString();
    await expect(ingestTrack(absentId, happyDeps)).rejects.toThrow();
  });

  it('missing audioSource: rejects with clear error', async () => {
    const track = await createTrack({ audioSource: undefined });
    await expect(ingestTrack(track._id.toString(), happyDeps)).rejects.toThrow(
      /no source audio/i,
    );

    const reloaded = await TrackModel.findById(track._id);
    expect(reloaded?.status).toBe('failed');
  });
});
