import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { connect, clear, disconnect } from '../../test/mongo';
import { ImportJobModel } from '../../models/ImportJob';
import { TrackModel } from '../../models/Track';
import { ArtistModel } from '../../models/Artist';
import { AlbumModel } from '../../models/Album';
import { runImport } from './importService';
import type { MusicSourceConnector } from './MusicSourceConnector';
import type { ExternalTrack } from '@syra/shared-types';

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

// ── Canned ExternalTrack fixtures ─────────────────────────────────────────────

const CC_TRACK_A: ExternalTrack = {
  provider: 'cc',
  externalId: 'cc-001',
  title: 'Open Road',
  durationSec: 210,
  artists: [{ name: 'Free Artist', externalId: 'fa-001' }],
  album: { name: 'Open Album', externalId: 'al-001' },
  images: [{ url: 'blob:test-cover', source: 'cc' }],
  downloadUrl: 'https://storage.jamendo.com/tracks/cc-001/audio.mp3',
  license: 'https://creativecommons.org/licenses/by/4.0/',
};

const CC_TRACK_B: ExternalTrack = {
  provider: 'cc',
  externalId: 'cc-002',
  title: 'Summer Breeze',
  durationSec: 180,
  artists: [{ name: 'Another Artist', externalId: 'aa-001' }],
  downloadUrl: 'https://storage.jamendo.com/tracks/cc-002/audio.mp3',
  license: 'https://creativecommons.org/licenses/by-sa/4.0/',
};

const AUDIUS_TRACK_A: ExternalTrack = {
  provider: 'audius',
  externalId: 'aud-001',
  title: 'Electric Dream',
  durationSec: 240,
  artists: [{ name: 'DJ Test', externalId: 'dj-001' }],
  streamUrl: 'https://discoveryprovider.audius.co/v1/tracks/aud-001/stream?app_name=Syra',
};

// ── Fake connectors ───────────────────────────────────────────────────────────

function makeCcConnector(tracks: ExternalTrack[] = [CC_TRACK_A, CC_TRACK_B]): MusicSourceConnector {
  return {
    provider: 'cc',
    search: async () => tracks,
  };
}

function makeAudiusConnector(tracks: ExternalTrack[] = [AUDIUS_TRACK_A]): MusicSourceConnector {
  return {
    provider: 'audius',
    search: async () => tracks,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runImport — CC path', () => {
  it('creates a completed ImportJob with correct counts', async () => {
    const downloadedIds: string[] = [];
    const enqueuedIds: string[] = [];

    const job = await runImport(makeCcConnector(), 'open', {
      deps: {
        downloadAndStore: async (_ext, trackId) => { downloadedIds.push(trackId); },
        enqueueIngest: (trackId) => { enqueuedIds.push(trackId); },
      },
    });

    expect(job.status).toBe('completed');
    expect(job.total).toBe(2);
    expect(job.imported).toBe(2);
    expect(job.failed).toBe(0);
    expect(job.provider).toBe('cc');
    expect(job.query).toBe('open');
  });

  it('persists an ImportJob doc in the database', async () => {
    await runImport(makeCcConnector(), 'q', {
      deps: {
        downloadAndStore: async () => {},
        enqueueIngest: () => {},
      },
    });

    const count = await ImportJobModel.countDocuments({ provider: 'cc', status: 'completed' });
    expect(count).toBe(1);
  });

  it('upserts 2 Track docs and their artists', async () => {
    await runImport(makeCcConnector(), 'q', {
      deps: {
        downloadAndStore: async () => {},
        enqueueIngest: () => {},
      },
    });

    expect(await TrackModel.countDocuments()).toBe(2);
    expect(await ArtistModel.countDocuments()).toBe(2);
  });

  it('imports and links album metadata when imported tracks include an album', async () => {
    await runImport(makeCcConnector([CC_TRACK_A]), 'album-track', {
      deps: {
        downloadAndStore: async () => {},
        enqueueIngest: () => {},
      },
    });

    const album = await AlbumModel.findOne({ sources: { $elemMatch: { provider: 'cc', externalId: 'al-001' } } });
    expect(album).not.toBeNull();
    expect(album?.title).toBe('Open Album');
    expect(album?.totalTracks).toBe(1);

    const track = await TrackModel.findOne({
      sources: { $elemMatch: { provider: 'cc', externalId: CC_TRACK_A.externalId } },
    });
    expect(track?.albumId).toBe(album?._id.toString());
  });

  it('calls downloadAndStore and enqueueIngest once per CC track', async () => {
    const downloadedIds: string[] = [];
    const enqueuedIds: string[] = [];

    await runImport(makeCcConnector(), 'q', {
      deps: {
        downloadAndStore: async (_ext, trackId) => { downloadedIds.push(trackId); },
        enqueueIngest: (trackId) => { enqueuedIds.push(trackId); },
      },
    });

    expect(downloadedIds).toHaveLength(2);
    expect(enqueuedIds).toHaveLength(2);
  });
});

describe('runImport — Audius path', () => {
  it('persists track with status "ready"; downloadAndStore / enqueueIngest NOT called', async () => {
    const downloadedIds: string[] = [];
    const enqueuedIds: string[] = [];

    const job = await runImport(makeAudiusConnector(), 'electric', {
      deps: {
        downloadAndStore: async (_ext, trackId) => { downloadedIds.push(trackId); },
        enqueueIngest: (trackId) => { enqueuedIds.push(trackId); },
      },
    });

    expect(job.status).toBe('completed');
    expect(job.imported).toBe(1);

    const track = await TrackModel.findOne({ title: 'Electric Dream' });
    expect(track).toBeDefined();
    expect(track?.status).toBe('ready');

    expect(downloadedIds).toHaveLength(0);
    expect(enqueuedIds).toHaveLength(0);
  });
});

describe('runImport — per-track failure isolation', () => {
  it('increments job.failed for a failing track; other tracks still imported; job status = completed', async () => {
    let callCount = 0;
    const job = await runImport(makeCcConnector(), 'q', {
      deps: {
        downloadAndStore: async (_ext, trackId) => {
          callCount += 1;
          if (callCount === 1) throw new Error('download failed');
          // second track succeeds
        },
        enqueueIngest: () => {},
      },
    });

    expect(job.status).toBe('completed');
    expect(job.failed).toBe(1);
    expect(job.imported).toBe(1);
    expect(job.total).toBe(2);
  });
});

describe('runImport — fatal error (connector.search throws)', () => {
  it('returns job with status "failed" and sets error field', async () => {
    const brokenConnector: MusicSourceConnector = {
      provider: 'cc',
      search: async () => { throw new Error('network timeout'); },
    };

    const job = await runImport(brokenConnector, 'q', {
      deps: {
        downloadAndStore: async () => {},
        enqueueIngest: () => {},
      },
    });

    expect(job.status).toBe('failed');
    expect(job.error).toContain('network timeout');
  });
});

describe('runImport — deduplication on re-run', () => {
  it('re-running the same import does not create duplicate Track or Artist docs', async () => {
    const deps = {
      downloadAndStore: async () => {},
      enqueueIngest: () => {},
    };

    await runImport(makeCcConnector([CC_TRACK_A]), 'q', { deps });
    await runImport(makeCcConnector([CC_TRACK_A]), 'q', { deps });

    expect(await TrackModel.countDocuments()).toBe(1);
    expect(await ArtistModel.countDocuments()).toBe(1);
  });
});

describe('runImport — empty artists guard', () => {
  it('skips a track with no artists and increments skipped, not imported', async () => {
    const noArtistTrack: ExternalTrack = {
      ...CC_TRACK_A,
      externalId: 'cc-no-artist',
      artists: [],
    };

    const job = await runImport(makeCcConnector([noArtistTrack]), 'q', {
      deps: {
        downloadAndStore: async () => {},
        enqueueIngest: () => {},
      },
    });

    expect(job.skipped).toBe(1);
    expect(job.imported).toBe(0);
    expect(job.status).toBe('completed');
  });
});
