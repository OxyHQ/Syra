/**
 * `POST /api/uploads`, end to end over real HTTP.
 *
 * Driven through a real express server with real multer rather than a fake `req`,
 * because multer parses a request STREAM: a hand-built request object cannot
 * reach the handler at all, and a test that skipped multipart would be testing a
 * code path that does not exist in production.
 *
 * Only STORAGE is faked. `ffprobe`, `music-metadata`, the provenance scorer, the
 * dedup chain, artist resolution and the contribution matrix all run for real
 * against the real fixtures, so an outcome asserted here is an outcome the
 * pipeline actually produced.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, mock } from 'bun:test';
import express from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import { connect, clear, disconnect } from '../test/mongo';
import * as realS3 from '../services/s3Service';
import * as realIngestQueue from '../services/ingest/ingestQueue';
import { UserUploadModel } from '../models/UserUpload';
import { TrackModel } from '../models/Track';
import { ArtistModel } from '../models/CatalogEntity';
import { AlbumModel } from '../models/Album';
import { ImageAssetModel } from '../models/ImageAsset';
import { TrackFingerprintModel } from '../models/TrackFingerprint';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { fingerprintFile } from '../services/uploads/fingerprint';
import uploadsRoutes from '../routes/uploads.routes';
import { search } from './search.controller';
import { getPopularTracks, getCharts, getHomeBrowse } from './browse.controller';

process.env.STREAM_TOKEN_SECRET = 'test-secret-uploads-create';

// ── Storage fakes ────────────────────────────────────────────────────────────

/** Every object key the pipeline asked to store, so a test can assert on WHICH. */
const storedKeys: string[] = [];
/** Every object key the pipeline asked to DELETE. */
const deletedKeys: string[] = [];
const deletedPrefixes: string[] = [];
/** Every id handed to locker ingest, so "was this queued for transcoding" is observable. */
const ingestedUploadIds: string[] = [];

// The real module minus the writes, so anything else that reaches S3 in this
// process still behaves normally rather than silently succeeding.
mock.module('../services/s3Service', () => ({
  ...realS3,
  deleteFromS3: async (key: string): Promise<void> => {
    deletedKeys.push(key);
  },
  deleteS3Prefix: async (prefix: string): Promise<number> => {
    deletedPrefixes.push(prefix);
    return 1;
  },
  /**
   * Drains the body the way the real client does.
   *
   * Not incidental: the controller hands S3 an `fs.ReadStream` over the multer
   * temp file and removes that file as soon as the call returns. A fake that
   * ignored the stream would leave it opening a path that no longer exists, and
   * the ENOENT would surface asynchronously in an unrelated test.
   */
  uploadToS3: async (key: string, body: unknown): Promise<void> => {
    storedKeys.push(key);
    if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
      for await (const _chunk of body as AsyncIterable<unknown>) {
        // drained
      }
    }
  },
}));

/**
 * ONLY `enqueueUploadIngest` is replaced, and the rest of the module is passed
 * through untouched.
 *
 * `mock.module` is process-global — it is not scoped to this file — so replacing
 * the whole module here would hand the fake to every other test in the run.
 * Replacing `enqueueIngest` did exactly that: `ingestQueue.test.ts` asserts that
 * it falls back to an in-process run when Redis is absent, and against the fake
 * it timed out. A narrow override is the difference between isolating this test
 * and quietly disabling somebody else's.
 */
mock.module('../services/ingest/ingestQueue', () => ({
  ...realIngestQueue,
  enqueueUploadIngest: async (uploadId: string): Promise<void> => {
    ingestedUploadIds.push(uploadId);
  },
}));


// ── Server ───────────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, '../services/uploads/__fixtures__');
const OWNER = 'oxy-owner';
const STRANGER = 'oxy-stranger';

let server: http.Server;
let baseUrl: string;
/** Which user the next request is made as; the test app injects it as the session. */
let currentUserId = OWNER;

beforeAll(async () => {
  await connect();

  const app = express();
  // Stand in for `oxy.auth()`: the routes self-enforce with `requireOxyAuth`,
  // which reads the resolved session off the request.
  app.use((req, _res, next) => {
    if (currentUserId) {
      (req as express.Request & { user?: { id: string } }).user = { id: currentUserId };
    }
    next();
  });
  app.use('/api/uploads', uploadsRoutes);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await clear();
  storedKeys.length = 0;
  deletedKeys.length = 0;
  deletedPrefixes.length = 0;
  ingestedUploadIds.length = 0;
  currentUserId = OWNER;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnect();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

async function postUpload(
  fixture: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const filePath = path.join(FIXTURES, fixture);
  const bytes = fs.readFileSync(filePath);
  const mime = MIME_BY_EXTENSION[path.extname(fixture)];

  const form = new FormData();
  form.append('audioFile', new Blob([bytes], { type: mime }), fixture);
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }

  const response = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: form });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface CapturedRes {
  _status: number;
  _body: unknown;
  status: (code: number) => CapturedRes;
  set: (name: string, value: string) => CapturedRes;
  json: (body: unknown) => CapturedRes;
  send: (body: unknown) => CapturedRes;
}

/** Rethrows whatever a handler passes to `next`, so a swallowed error fails loudly. */
const rethrow = (error: unknown): void => { if (error) throw error; };

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    set() { return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
  };
  return res;
}

// ── Private destination ──────────────────────────────────────────────────────

describe('POST /api/uploads — private destination', () => {
  it('stores an untagged file with NO artist, which is valid on this path', async () => {
    // The asymmetry the whole feature turns on: a locker exists for exactly the
    // uncatalogued, badly-tagged material people want to preserve. Refusing this
    // would refuse the reason the locker exists. (The PUBLIC path rejects it —
    // see the test below.)
    const { status, body } = await postUpload('untagged.wav', { destination: 'private' });

    expect(status).toBe(201);
    expect(body.outcome).toBe('stored');

    const upload = body.upload as Record<string, unknown>;
    expect(upload.kind).toBe('upload');
    expect(upload.artistName).toBe('');
    // ffprobe measured this, nobody typed it.
    expect(upload.duration).toBeGreaterThan(0);

    const rows = await UserUploadModel.find({ ownerOxyUserId: OWNER }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('processing');
    expect(ingestedUploadIds).toEqual([String(upload.id)]);
  });

  it('never returns a storage key to the client', async () => {
    const { body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });

    const stored = await UserUploadModel.findOne({ ownerOxyUserId: OWNER }).lean();
    const audioKey = stored?.audioSource?.key;
    if (!audioKey) throw new Error('the stored locker row recorded no audio key');

    // The key exists in storage and in the document, and is absent from the wire.
    expect(storedKeys).toContain(audioKey);
    expect(JSON.stringify(body)).not.toContain(audioKey);
  });

  it('writes nothing into the catalogue', async () => {
    // The structural guarantee: a private file lives in its own collection, so no
    // catalog read can reach it. If a later change ever writes a locker row into
    // `tracks`, this is what says so.
    await postUpload('indie-id3v2.mp3', { destination: 'private' });

    expect(await TrackModel.countDocuments({})).toBe(0);
    expect(await UserUploadModel.countDocuments({})).toBe(1);
  });

  it('deletes the stored bytes when the owner deletes the file', async () => {
    const { body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });
    const uploadId = String((body.upload as { id: string }).id);
    const audioKey = (await UserUploadModel.findById(uploadId).lean())?.audioSource?.key;
    if (!audioKey) throw new Error('the stored locker row recorded no audio key');

    const response = await fetch(`${baseUrl}/api/uploads/${uploadId}`, { method: 'DELETE' });

    expect(response.status).toBe(204);
    // Bytes first, then the document. A row removed before its objects leaves
    // audio in the bucket that nothing will ever name again.
    expect(deletedKeys).toContain(audioKey);
    // No HLS directory is swept, because this file has not been transcoded yet
    // and so records no master manifest. The prefix guard refuses to empty a
    // directory it cannot name from the document itself.
    expect(deletedPrefixes).toEqual([]);
    expect(await UserUploadModel.findById(uploadId).lean()).toBeNull();
  });

  it('takes the uploader’s metadata overrides over the file’s own tags', async () => {
    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'private',
      title: 'What I Call It',
      year: '1999',
    });

    const upload = body.upload as Record<string, unknown>;
    expect(upload.title).toBe('What I Call It');
    expect((await UserUploadModel.findOne({}).lean())?.year).toBe(1999);
  });

  it('titles an untagged file from the name the uploader gave it', async () => {
    // Found only by a real HTTP run: multer writes to a temp path whose basename
    // is a random hash, so falling back to it titled the file
    // `0a89647fda60ee8d18086f7a73180de7`. A file with no title tag is precisely
    // the material a locker exists for, and its filename is all the meaning left.
    const { body } = await postUpload('untagged.wav', { destination: 'private' });

    expect((body.upload as { title: string }).title).toBe('untagged');
  });

  it('rejects a metadata field that is not the type it claims', async () => {
    const { status, body } = await postUpload('indie-id3v2.mp3', {
      destination: 'private',
      trackNumber: 'side b',
    });

    // Recovered from multipart, not coerced away: the uploader is told, rather
    // than having the value silently dropped.
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid request body');
    expect(await UserUploadModel.countDocuments({})).toBe(0);
  });
});

// ── Duplicate ────────────────────────────────────────────────────────────────

describe('POST /api/uploads — the same bytes twice', () => {
  it('answers `duplicate` with the id of the copy already held', async () => {
    const first = await postUpload('indie-id3v2.mp3', { destination: 'private' });
    const firstId = (first.body.upload as { id: string }).id;

    const second = await postUpload('indie-id3v2.mp3', { destination: 'private' });

    expect(second.status).toBe(200);
    expect(second.body.outcome).toBe('duplicate');
    expect(second.body.uploadId).toBe(firstId);
    expect(await UserUploadModel.countDocuments({})).toBe(1);
  });

  it('lets a DIFFERENT owner keep their own copy of the same recording', async () => {
    await postUpload('indie-id3v2.mp3', { destination: 'private' });

    currentUserId = STRANGER;
    const { status, body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });

    // A locker is one person's storage; the same file in two lockers is two
    // independent copies, not a duplicate.
    expect(status).toBe(201);
    expect(body.outcome).toBe('stored');
    expect(await UserUploadModel.countDocuments({})).toBe(2);
  });
});

// ── Already in the catalogue ─────────────────────────────────────────────────

describe('POST /api/uploads — already in the public catalogue', () => {
  it('does not store the bytes at all', async () => {
    // Matched through the ISRC tier, which the fixture carries in its `TSRC`
    // frame. The sha256 tier would be the more direct route and is deliberately
    // NOT used here: `matchCatalog.findCatalogTrackByHash` is still a stub that
    // returns null, so a test written against it would assert nothing.
    const existing = await TrackModel.create({
      title: 'Already Here',
      artistId: 'artist-1',
      artistName: 'Nadia Ortiz',
      duration: 210,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      isExplicit: false,
      externalIds: { isrc: 'ESA452300137' },
    });

    const { status, body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });

    expect(status).toBe(200);
    expect(body.outcome).toBe('matched');
    expect(body.trackId).toBe(existing._id.toString());

    // The point of the whole ordering: dedup runs before storage, so a recording
    // Syra already distributes is never transferred a second time.
    expect(storedKeys).toEqual([]);
    expect(await UserUploadModel.countDocuments({})).toBe(0);
    expect(ingestedUploadIds).toEqual([]);
  });
});

// ── Public destination ───────────────────────────────────────────────────────

describe('POST /api/uploads — public destination', () => {
  it('REJECTS a file with no artist instead of quietly filing it in the locker', async () => {
    const { status, body } = await postUpload('untagged.wav', {
      destination: 'public',
      attestation: 'I have the right to distribute this recording.',
    });

    expect(status).toBe(422);
    expect(body.outcome).toBe('blocked');
    expect(body.code).toBe('artist_unresolved');
    expect(typeof body.message).toBe('string');

    // The refusal is the point: a silent downgrade would leave the uploader
    // believing they had published, and leave a recording in the catalogue with
    // nobody to attribute it to or address a takedown to.
    expect(await UserUploadModel.countDocuments({})).toBe(0);
    expect(await TrackModel.countDocuments({})).toBe(0);
  });

  it('blocks a purchased file, names the marker, and leaves no artist behind', async () => {
    const { status, body } = await postUpload('purchased-itunes.m4a', {
      destination: 'public',
      attestation: 'I have the right to distribute this recording.',
    });

    expect(status).toBe(403);
    expect(body.outcome).toBe('blocked');
    expect(body.code).toBe('commercial_provenance');

    // The markers travel with the verdict so the block can be explained — and
    // appealed. A refusal that cannot say what refused it is not reviewable.
    const markers = body.markers as Array<{ code: string; weight: string }>;
    expect(markers.some((marker) => marker.weight === 'blocking')).toBe(true);
    expect(markers.map((marker) => marker.code)).toContain('itunes.purchase-atoms');

    expect(await TrackModel.countDocuments({})).toBe(0);
    // Screening runs before resolution precisely so a refused upload does not
    // seed the catalogue with a claimable artist profile.
    expect(await ArtistModel.countDocuments({})).toBe(0);
  });
});

// ── Artwork and album containers ─────────────────────────────────────────────

describe('embedded cover art', () => {
  it('stores the FRONT cover and never the artist photo beside it', async () => {
    // The fixture carries three pictures: front cover, back cover and an
    // `Artist/performer` shot. Only the first is this release's artwork; turning
    // a photo that happened to be in an MP3 into a profile picture is a different
    // act from attaching cover art, and it is not one an upload may perform.
    const { body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });

    const coverArt = (await UserUploadModel.findOne({}).lean())?.coverArt;
    if (!coverArt) throw new Error('no cover art was stored for a file that carries one');

    const asset = await ImageAssetModel.findById(coverArt).lean();
    expect(asset?.ownerType).toBe('upload');
    expect(asset?.width).toBe(96);
    expect((body.upload as { coverArt?: string }).coverArt).toBe(`/api/images/${coverArt}`);
    // One image stored, not three.
    expect(await ImageAssetModel.countDocuments({})).toBe(1);
  });

  it('keeps a thumbnail out of the catalogue while keeping it in the locker', async () => {
    // 96×96 is fine in somebody's own library and blurry on an album page, and
    // promoting one is not reversible in practice.
    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'public',
      attestation: 'I have the right to distribute this recording.',
    });

    if (body.outcome !== 'published') {
      throw new Error(`expected the fixture to publish, got ${JSON.stringify(body)}`);
    }

    const track = await TrackModel.findById(String(body.trackId)).lean();
    expect(track?.coverArt).toBeUndefined();
    // ...and with no artwork there is no album, because the alternative is
    // inventing a placeholder cover.
    expect(track?.albumId).toBeUndefined();
    expect(await AlbumModel.countDocuments({})).toBe(0);
  });
});

describe('album containers', () => {
  it('creates the release and links the track when the artwork is good enough', async () => {
    // The uploader named an image of their own, which is their explicit choice
    // and bypasses the embedded-thumbnail floor.
    const cover = await ImageAssetModel.create({
      s3Key: 'images/cover/large.jpg',
      filename: 'large.jpg',
      contentType: 'image/jpeg',
      byteSize: 4096,
      width: 1400,
      height: 1400,
      ownerType: 'album',
    });

    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'public',
      coverArt: cover._id.toString(),
      attestation: 'I have the right to distribute this recording.',
    });

    expect(body.outcome).toBe('published');

    const album = await AlbumModel.findOne({}).lean();
    expect(album?.title).toBe('Harbour Lights');
    expect(album?.artistName).toBe('Nadia Ortiz');
    // The right-hand side of `TRCK` (`3/12`) — a property of the RELEASE, not a
    // count of what Syra hosts. It must NOT climb with each contribution; an
    // earlier version incremented it and reported 13 after a single upload.
    expect(album?.totalTracks).toBe(12);
    // A 12-track release is an album. It was classified `ep` while the caller
    // passed one track's duration as the release's total running time.
    expect(album?.type).toBe('album');
    expect(album?.upc).toBe('8437011234567');

    const track = await TrackModel.findById(String(body.trackId)).lean();
    expect(track?.albumId).toBe(album?._id.toString());
    expect(track?.albumName).toBe('Harbour Lights');
  });

  it('indexes the published track by hash AND acoustically', async () => {
    /**
     * Both of these are READ by code that existed long before anything wrote
     * them: `matchCatalog` tier 1 reads `Track.sha256`, and tier 3 plus the third
     * leg of compliance's takedown purge read `TrackFingerprint`. Until the
     * publication path filled them, every one of those queries ran against a
     * field nobody set and a collection nobody populated — mechanisms that
     * typecheck, pass their own unit tests, and never match anything.
     */
    const cover = await ImageAssetModel.create({
      s3Key: 'images/cover/large.jpg',
      filename: 'large.jpg',
      contentType: 'image/jpeg',
      byteSize: 4096,
      width: 1400,
      height: 1400,
      ownerType: 'album',
    });

    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'public',
      coverArt: cover._id.toString(),
      attestation: 'I have the right to distribute this recording.',
    });
    expect(body.outcome).toBe('published');

    const trackId = String(body.trackId);
    // `sha256` is `select: false`, so it has to be asked for explicitly.
    const track = await TrackModel.findById(trackId).select('+sha256').lean();
    expect(track?.sha256).toMatch(/^[a-f0-9]{64}$/);

    // The fingerprint row only exists where `fpcalc` is installed; the assertion
    // adapts rather than pretending, so this test is honest on both machines.
    const indexed = await TrackFingerprintModel.findOne({ trackId }).lean();
    const acoustic = await fingerprintFile(path.join(FIXTURES, 'indie-id3v2.mp3'));
    if (acoustic.status === 'ok') {
      expect(indexed?.fingerprint.length).toBeGreaterThan(0);
      expect(indexed?.fingerprintDurationSec).toBeGreaterThan(0);
    } else {
      expect(indexed).toBeNull();
    }
  });

  it('reuses the existing release instead of creating a second one', async () => {
    const cover = await ImageAssetModel.create({
      s3Key: 'images/cover/large.jpg',
      filename: 'large.jpg',
      contentType: 'image/jpeg',
      byteSize: 4096,
      width: 1400,
      height: 1400,
      ownerType: 'album',
    });

    // Same UPC — a barcode identifies a RELEASE, so this is the same album.
    const existing = await AlbumModel.create({
      title: 'Harbour Lights',
      artistId: 'artist-1',
      artistName: 'Nadia Ortiz',
      releaseDate: '2023-04-18',
      coverArt: cover._id.toString(),
      type: 'album',
      source: 'upload',
      upc: '8437011234567',
    });

    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'public',
      coverArt: cover._id.toString(),
      attestation: 'I have the right to distribute this recording.',
    });

    expect(body.outcome).toBe('published');
    expect(await AlbumModel.countDocuments({})).toBe(1);
    expect((await TrackModel.findById(String(body.trackId)).lean())?.albumId).toBe(
      existing._id.toString(),
    );
  });
});

// ── The evidence chain ───────────────────────────────────────────────────────

describe('rawTags — the DMCA audit record', () => {
  it('persists the file’s own tags on the locker row', async () => {
    /**
     * A claim months later is answered by what the file DECLARED at upload time.
     * The normalised columns are a lossy view of that and the source object may
     * be gone, so if this is not stored the evidence chain does not exist —
     * which was true until this was wired, while a comment in `extractMetadata`
     * asserted the opposite.
     */
    await postUpload('indie-id3v2.mp3', { destination: 'private' });

    // `select: false`, so it has to be asked for — which is also what keeps it
    // off every client read.
    const stored = await UserUploadModel.findOne({}).select('+rawTags').lean();
    expect(stored?.rawTags?.json).toBeTruthy();
    expect(stored?.rawTags?.originalByteLength).toBeGreaterThan(0);

    // It is the real tag dump, not a placeholder.
    const parsed = JSON.parse(stored?.rawTags?.json ?? '[]') as Array<{ id: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((tag) => tag.id === 'TSRC')).toBe(true);

    /**
     * And it never reaches the client — on the DTO's own terms.
     *
     * The guard that matters is `toUploadTrackDto` naming its fields, NOT the
     * model's `select: false`: that projection has already been removed once
     * while the comment asserting it survived, and it is inert against
     * `aggregate()` regardless. This assertion fails if the serializer ever
     * starts spreading the document, which is the failure mode worth catching.
     */
    for (const route of ['/api/uploads', `/api/uploads/${(await UserUploadModel.findOne({}).lean())?._id.toString()}`]) {
      const serialised = JSON.stringify(await (await fetch(`${baseUrl}${route}`)).json());
      expect(`${route}: ${serialised.includes('rawTags')}`).toBe(`${route}: false`);
    }
  });

  it('persists them on the attestation too, beside the signature', async () => {
    const cover = await ImageAssetModel.create({
      s3Key: 'images/cover/large.jpg', filename: 'large.jpg', contentType: 'image/jpeg',
      byteSize: 4096, width: 1400, height: 1400, ownerType: 'album',
    });

    const { body } = await postUpload('indie-id3v2.mp3', {
      destination: 'public',
      coverArt: cover._id.toString(),
      attestation: 'I have the right to distribute this recording.',
    });
    expect(body.outcome).toBe('published');

    const attestation = await ContributionAttestationModel.findOne({ trackId: String(body.trackId) })
      .select('+rawTags')
      .lean();
    // The statement alone proves only that a box was ticked; the pair proves what
    // the uploader was looking at when they ticked it.
    expect(attestation?.statement).toContain('right to distribute');
    expect(attestation?.rawTags?.json).toBeTruthy();
    expect(attestation?.provenanceReport?.verdict).toBeTruthy();
  });
});

// ── Locker albums ────────────────────────────────────────────────────────────

describe('GET /api/uploads/albums', () => {
  it('groups the locker by album key without creating any catalogue Album', async () => {
    await postUpload('indie-id3v2.mp3', { destination: 'private' });
    await postUpload('cdrip-picard.flac', { destination: 'private' });

    const response = await fetch(`${baseUrl}/api/uploads/albums`);
    const body = (await response.json()) as {
      albums: Array<{ albumKey: string; albumName?: string; albumArtistName?: string; trackCount: number; trackIds: string[] }>;
      total: number;
    };

    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.albums.map((a) => a.albumName).sort()).toEqual(['Harbour Lights', 'The Longest Winter']);
    // Titled from the ALBUM artist, not the track artist — the fixture's track
    // artist is "Nadia Ortiz feat. Kofi Mensah".
    const harbour = body.albums.find((a) => a.albumName === 'Harbour Lights');
    expect(harbour?.albumArtistName).toBe('Nadia Ortiz');
    expect(harbour?.trackCount).toBe(1);
    expect(harbour?.trackIds).toHaveLength(1);
    expect(harbour?.albumKey).toBeTruthy();

    // The whole point of the aggregation: no catalogue container is created.
    expect(await AlbumModel.countDocuments({})).toBe(0);

    /**
     * `aggregate()` IGNORES Mongoose `select: false`, so on this route that
     * projection protects nothing — the response mapping is the only guard.
     *
     * Mutation-tested, and the result corrected this comment: adding
     * `$push: '$$ROOT'` to the `$group` alone does NOT fail this assertion,
     * because the `.map()` below still picks its fields by name. What DOES fail
     * it is the `.map()` spreading the grouped document. So this guards the
     * serializer, not the pipeline — worth stating precisely, because a raw tag
     * dump can carry an iTunes `apID` (the purchaser's email address) and
     * believing the wrong layer protects it is how that ships.
     */
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('rawTags');
    expect(serialised).not.toContain('audioSource');
    expect(serialised).not.toContain('sha256');
  });

  it('shows a listener nothing of anybody else’s locker', async () => {
    await postUpload('indie-id3v2.mp3', { destination: 'private' });

    currentUserId = STRANGER;
    const response = await fetch(`${baseUrl}/api/uploads/albums`);

    expect(((await response.json()) as { total: number }).total).toBe(0);
  });

  it('leaves a file with no album tags out rather than inventing a group', async () => {
    await postUpload('untagged.wav', { destination: 'private' });

    const body = (await (await fetch(`${baseUrl}/api/uploads/albums`)).json()) as { total: number };
    expect(body.total).toBe(0);
    // The file itself is still in the locker; it just belongs to no release.
    expect(await UserUploadModel.countDocuments({})).toBe(1);
  });

  it('is not shadowed by the `/:id` route', async () => {
    // `albums` is a valid-looking path segment; registered after `/:id` Express
    // would match it as an upload id and answer 404 forever.
    const response = await fetch(`${baseUrl}/api/uploads/albums`);
    expect(response.status).toBe(200);
  });
});

// ── The invisibility guarantee ───────────────────────────────────────────────

describe('a private upload is invisible to everybody else', () => {
  it('never appears in search, browse, charts or the home feed for another user', async () => {
    const { body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });
    const stored = await UserUploadModel.findOne({}).lean();
    const title = stored?.title ?? '';
    expect(title.length).toBeGreaterThan(0); // vacuity floor: there IS something to find

    // Every catalog surface reads `tracks` through `playableTrackFilter`, which
    // has no owner dimension and must never gain one. The locker being a separate
    // collection is what makes that safe — so the assertion is not merely "the
    // stranger sees nothing", it is "the catalogue never held it".
    expect(await TrackModel.countDocuments({})).toBe(0);

    const uploadId = String((body.upload as { id: string }).id);
    currentUserId = STRANGER;

    const surfaces: Array<[string, (res: CapturedRes) => Promise<void>]> = [
      ['search', async (res) => {
        const req = { query: { q: title }, params: {}, user: { id: STRANGER } };
        await search(req as never, res as never, rethrow);
      }],
      ['popular tracks', async (res) => {
        const req = { query: {}, params: {}, user: { id: STRANGER } };
        await getPopularTracks(req as never, res as never, rethrow);
      }],
      ['charts', async (res) => {
        const req = { query: {}, params: {}, user: { id: STRANGER } };
        await getCharts(req as never, res as never, rethrow);
      }],
      ['home browse', async (res) => {
        const req = { query: {}, params: {}, user: { id: STRANGER } };
        await getHomeBrowse(req as never, res as never, rethrow);
      }],
    ];

    // The id, not the title. Searching for a title makes the response contain
    // that title whatever the results are — `search` echoes `query` back — so a
    // substring check on the title cannot tell a leak from an echo. The upload id
    // appears nowhere except in an actual result.
    for (const [name, run] of surfaces) {
      const res = makeRes();
      await run(res);
      const serialised = JSON.stringify(res._body ?? {});
      expect(`${name} leaked the id: ${serialised.includes(uploadId)}`).toBe(
        `${name} leaked the id: false`,
      );
    }

    const searchRes = makeRes();
    await search(
      { query: { q: title }, params: {}, user: { id: STRANGER } } as never,
      searchRes as never,
      rethrow,
    );
    expect((searchRes._body as { counts: { total: number } }).counts.total).toBe(0);
  });

  it('positive control: the same search DOES find a catalogue track', async () => {
    // Without this, the assertions above pass just as happily against a search
    // that is broken and returns nothing at all — which is the difference between
    // a guarantee and a check that cannot fail.
    const upload = await postUpload('indie-id3v2.mp3', { destination: 'private' });
    const title = (await UserUploadModel.findOne({}).lean())?.title ?? '';

    const track = await TrackModel.create({
      title,
      artistId: 'artist-1',
      artistName: 'Nadia Ortiz',
      duration: 210,
      source: 'upload',
      status: 'ready',
      isAvailable: true,
      isExplicit: false,
    });

    currentUserId = STRANGER;
    const res = makeRes();
    await search(
      { query: { q: title }, params: {}, user: { id: STRANGER } } as never,
      res as never,
      rethrow,
    );

    const body = res._body as { counts: { total: number }; results: { tracks: Array<{ id: string }> } };
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.results.tracks.map((found) => found.id)).toEqual([track._id.toString()]);
    // Same title, same search, same viewer — the catalogue copy is found and the
    // locker copy is not.
    expect(body.results.tracks.map((found) => found.id)).not.toContain(
      String((upload.body.upload as { id: string }).id),
    );
  });

  it('is not readable through the locker API by another user either', async () => {
    const { body } = await postUpload('indie-id3v2.mp3', { destination: 'private' });
    const uploadId = (body.upload as { id: string }).id;

    currentUserId = STRANGER;

    for (const suffix of ['', '/stream']) {
      const response = await fetch(`${baseUrl}/api/uploads/${uploadId}${suffix}`);
      expect(`${suffix || '/'} → ${response.status}`).toBe(`${suffix || '/'} → 404`);
    }

    const list = await fetch(`${baseUrl}/api/uploads`);
    expect(((await list.json()) as { total: number }).total).toBe(0);
  });
});
