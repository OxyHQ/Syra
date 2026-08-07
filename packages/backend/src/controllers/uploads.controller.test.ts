import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { userUploadHlsRenditions, userUploads } from '../db/schema/creators';
import { trackKeys } from '../db/schema/catalog';
import { UPLOAD_COLUMNS } from '../db/creators/uploads';
import { toUploadTrackDto, uploadImageIds } from '../db/creators/serialize';
import { loadImageVariants } from '../db/catalog/hydrate';
import {
  getUpload,
  getUploadStream,
  getUploadStreamKey,
  getUploadMasterPlaylist,
  listUploads,
  updateUpload,
  deleteUpload,
} from './uploads.controller';
import { mintStreamToken, verifyStreamToken } from '../services/stream/streamToken';

// Set before the module under test reads it — the minting helper has no fallback.
process.env.STREAM_TOKEN_SECRET = 'test-secret-uploads-controller';

beforeAll(connectDb);
afterEach(clearDb);
afterAll(disconnectDb);

const OWNER = 'oxy-owner';
const STRANGER = 'oxy-stranger';

// ── Fake req/res ─────────────────────────────────────────────────────────────

interface CapturedRes {
  _status: number;
  _body: unknown;
  _headers: Record<string, string>;
  status: (code: number) => CapturedRes;
  set: (name: string, value: string) => CapturedRes;
  send: (body: unknown) => CapturedRes;
  json: (body: unknown) => CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
    _status: 200,
    _body: undefined,
    _headers: {},
    status(code) { this._status = code; return this; },
    set(name, value) { this._headers[name] = value; return this; },
    send(body) { this._body = body; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

function makeReq(
  params: Record<string, string>,
  opts: { userId?: string; query?: Record<string, string>; body?: unknown } = {},
): AuthRequest {
  return {
    params,
    query: opts.query ?? {},
    body: opts.body ?? {},
    user: opts.userId ? { id: opts.userId } : undefined,
  } as unknown as AuthRequest;
}

/** Rethrows whatever a handler passes to `next`, so a swallowed error fails loudly. */
function rethrow(error: unknown): void {
  if (error) throw error;
}

// ── Seeds ────────────────────────────────────────────────────────────────────

let shaCounter = 0;

type UploadOverrides = Partial<typeof userUploads.$inferInsert> & { withHls?: boolean };

async function seedUpload(
  overrides: UploadOverrides = {}
): Promise<{ id: string; sha256: string }> {
  shaCounter += 1;
  const { withHls = true, ...columns } = overrides;
  const [upload] = await getDb()
    .insert(userUploads)
    .values({
      ownerOxyUserId: OWNER,
      title: 'Midnight Ferry',
      artistName: 'Nadia Ortiz',
      duration: 210,
      sizeBytes: 5_242_880,
      sha256: shaCounter.toString(16).padStart(64, '0'),
      status: 'ready',
      playCount: 0,
      audioSourceKey: 'locker/oxy-owner/abc/source.mp3',
      audioSourceFormat: 'mp3',
      hlsMasterKey: 'hls/locker/oxy-owner/abc/master.m3u8',
      ...columns,
    })
    .returning({ id: userUploads.id, sha256: userUploads.sha256 });

  // The ladder is `user_upload_hls_renditions` now, so a fixture that needs a
  // playable file needs a second insert.
  if (withHls) {
    await getDb().insert(userUploadHlsRenditions).values({
      userUploadId: upload.id,
      position: 0,
      manifestKey: 'hls/locker/oxy-owner/abc/160/index.m3u8',
      bitrateKbps: 160,
      encrypted: true,
    });
  }
  return upload;
}

/** The stored row, read back directly rather than through a production helper. */
async function reload(uploadId: string) {
  const [row] = await getDb().select().from(userUploads).where(eq(userUploads.id, uploadId));
  return row;
}

/** The row as a production caller sees it, plus its image lookup. */
async function dtoFor(uploadId: string) {
  const [row] = await getDb()
    .select(UPLOAD_COLUMNS)
    .from(userUploads)
    .where(eq(userUploads.id, uploadId));
  return toUploadTrackDto(row, await loadImageVariants(uploadImageIds(row)));
}

// ── The serialisation boundary ───────────────────────────────────────────────

describe('toUploadTrackDto', () => {
  it('carries no storage key of any kind', async () => {
    const upload = await seedUpload();

    const dto = await dtoFor(upload.id);
    const serialised = JSON.stringify(dto);

    // The assertion that matters: the stored record holds a raw S3 key for the
    // source object, the master manifest and every rendition. A client that
    // received any of them would hold a way around the ownership check the day
    // the bucket policy is loosened by anyone, for any reason.
    expect(dto.audioSource).toBeUndefined();
    expect(dto.hlsMasterKey).toBeUndefined();
    expect(dto.hls).toBeUndefined();
    expect(serialised).not.toContain('locker/oxy-owner/abc/source.mp3');
    expect(serialised).not.toContain('hls/locker/oxy-owner/abc/master.m3u8');
    expect(serialised).not.toContain('hls/locker/oxy-owner/abc/160/index.m3u8');
  });

  it('is tagged `upload` so the player resolves it through the locker', async () => {
    const upload = await seedUpload();

    expect((await dtoFor(upload.id)).kind).toBe('upload');
  });

  it('renders an unresolved artist as empty strings, not as a placeholder name', async () => {
    // A file with no artist tag is a valid private upload. The UI renders its own
    // "Unknown artist" so the backend never ships a language-specific string.
    const upload = await seedUpload({ artistName: null, resolvedArtistId: null });

    const dto = await dtoFor(upload.id);
    expect(dto.artistName).toBe('');
    expect(dto.artistId).toBe('');
  });

  it('reports a soft-deleted file as unavailable', async () => {
    const upload = await seedUpload({ deletedAt: new Date() });

    expect((await dtoFor(upload.id)).isAvailable).toBe(false);
  });
});

// ── Reads ────────────────────────────────────────────────────────────────────

describe('GET /api/uploads/:id', () => {
  it('returns the owner their own file', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await getUpload(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(200);
    expect((res._body as { id: string }).id).toBe(upload.id);
  });

  it('answers 404 — not 403 — to a DIFFERENT session', async () => {
    // 404 rather than 403 on purpose: a stranger must not be able to tell a real
    // locker id apart from one that does not exist, or the ids themselves become
    // enumerable.
    const upload = await seedUpload();
    const res = makeRes();

    await getUpload(makeReq({ id: upload.id }, { userId: STRANGER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(404);
  });

  it('hides a soft-deleted file from its own owner', async () => {
    const upload = await seedUpload({ deletedAt: new Date() });
    const res = makeRes();

    await getUpload(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(404);
  });
});

describe('GET /api/uploads', () => {
  it('lists only the caller’s own files', async () => {
    await seedUpload({ title: 'Mine' });
    await seedUpload({ ownerOxyUserId: STRANGER, title: 'Theirs' });
    const res = makeRes();

    await listUploads(makeReq({}, { userId: OWNER }), res as unknown as Response, rethrow);

    const body = res._body as { uploads: Array<{ title: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.uploads.map((upload) => upload.title)).toEqual(['Mine']);
  });

  it('omits soft-deleted files', async () => {
    await seedUpload({ title: 'Live' });
    await seedUpload({ title: 'Expired', deletedAt: new Date() });
    const res = makeRes();

    await listUploads(makeReq({}, { userId: OWNER }), res as unknown as Response, rethrow);

    expect((res._body as { uploads: Array<{ title: string }> }).uploads.map((u) => u.title)).toEqual(['Live']);
  });
});

// ── Writes ───────────────────────────────────────────────────────────────────

describe('PATCH /api/uploads/:id', () => {
  it('applies the whitelisted fields', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await updateUpload(
      makeReq({ id: upload.id }, { userId: OWNER, body: { title: 'Corrected Title' } }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(200);
    expect((await reload(upload.id))?.title).toBe('Corrected Title');
  });

  it('cannot be used to reassign ownership or rewrite the retention stamps', async () => {
    // Mass assignment is IDOR: the body is parsed against a whitelist and never
    // spread onto the document, so none of these can be reached from here.
    const upload = await seedUpload();
    const originalExpiry = new Date('2027-01-01T00:00:00.000Z');
    await getDb()
      .update(userUploads)
      .set({ expiresAt: originalExpiry })
      .where(eq(userUploads.id, upload.id));

    const res = makeRes();
    await updateUpload(
      makeReq(
        { id: upload.id },
        {
          userId: OWNER,
          body: {
            title: 'Corrected Title',
            ownerOxyUserId: STRANGER,
            sha256: 'f'.repeat(64),
            expiresAt: new Date('2099-01-01T00:00:00.000Z').toISOString(),
            matchedTrackId: uuidv7(),
            // Both spellings, because `audioSource` was one embedded
            // subdocument and is two flattened columns now — a body naming
            // either must reach neither.
            audioSource: { key: 'hacked', format: 'mp3' },
            audioSourceKey: 'hacked',
          },
        },
      ),
      res as unknown as Response,
      rethrow,
    );

    const after = await reload(upload.id);
    expect(after?.ownerOxyUserId).toBe(OWNER);
    expect(after?.sha256).toBe(upload.sha256);
    expect(after?.expiresAt?.getTime()).toBe(originalExpiry.getTime());
    expect(after?.matchedTrackId).toBeNull();
    expect(after?.audioSourceKey).toBe('locker/oxy-owner/abc/source.mp3');
  });

  it('refuses a stranger', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await updateUpload(
      makeReq({ id: upload.id }, { userId: STRANGER, body: { title: 'Yours now' } }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
    expect((await reload(upload.id))?.title).toBe('Midnight Ferry');
  });
});

describe('DELETE /api/uploads/:id', () => {
  it('removes the document and its stream key', async () => {
    // Seeded with NO storage keys, so `deleteUploadStoredObjects` has nothing to
    // ask S3 for and this test stays about the DOCUMENT side of the delete. That
    // the bytes go too is asserted end to end, against a real upload, in
    // `uploads.createUpload.test.ts` — the file that owns the storage fake.
    const upload = await seedUpload({
      audioSourceKey: null,
      audioSourceFormat: null,
      hlsMasterKey: null,
      withHls: false,
    });
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: upload.id, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const res = makeRes();

    await deleteUpload(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(204);
    expect(await reload(upload.id)).toBeUndefined();
    expect(
      await getDb().select().from(trackKeys).where(eq(trackKeys.trackId, upload.id))
    ).toEqual([]);
  });

  it('refuses a stranger, and keeps the file', async () => {
    const upload = await seedUpload({
      audioSourceKey: null,
      audioSourceFormat: null,
      hlsMasterKey: null,
      withHls: false,
    });
    const res = makeRes();

    await deleteUpload(makeReq({ id: upload.id }, { userId: STRANGER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(404);
    expect(await reload(upload.id)).toBeDefined();
  });
});

// ── Streaming ────────────────────────────────────────────────────────────────

describe('GET /api/uploads/:id/stream', () => {
  it('mints a session bound to the upload and the owner', async () => {
    const upload = await seedUpload();
    const uploadId = upload.id;
    const res = makeRes();

    await getUploadStream(makeReq({ id: uploadId }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(200);
    const body = res._body as { url: string; type: string };
    expect(body.type).toBe('hls');
    expect(body.url).toContain(`/api/uploads/${uploadId}/stream/master.m3u8?t=`);

    const token = body.url.split('?t=')[1];
    const claims = verifyStreamToken(token);
    expect(claims?.trackId).toBe(uploadId);
    expect(claims?.userId).toBe(OWNER);
  });

  it('pushes the expiry a year forward — playing a file is what keeps it', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const upload = await seedUpload({ expiresAt: soon });
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    const after = await reload(upload.id);
    expect(after?.playCount).toBe(1);
    expect(after?.lastPlayedAt).toBeDefined();
    expect(after?.expiresAt?.getTime()).toBeGreaterThan(soon.getTime());
  });

  it('answers 404 to a different session', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, { userId: STRANGER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(404);
    expect(res._body).not.toHaveProperty('url');
  });

  it('does not record a play for a session that was refused', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, { userId: STRANGER }), res as unknown as Response, rethrow);

    expect((await reload(upload.id))?.playCount).toBe(0);
  });

  it('refuses an anonymous caller', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, {}), res as unknown as Response, rethrow);

    expect(res._status).toBe(401);
  });

  it('will not mint a session from a stream token — the resolver ISSUES them', async () => {
    const upload = await seedUpload();
    const uploadId = upload.id;
    const token = mintStreamToken({ trackId: uploadId, userId: OWNER, maxBitrateKbps: 160 }, 60);
    const res = makeRes();

    await getUploadStream(
      makeReq({ id: uploadId }, { query: { t: token } }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(401);
  });

  it('answers 409 while the file is still being transcoded', async () => {
    const upload = await seedUpload({ status: 'processing', hlsMasterKey: null, withHls: false });
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(409);
  });

  it('answers 422 for a file whose ingest failed', async () => {
    const upload = await seedUpload({ status: 'failed', hlsMasterKey: null, withHls: false });
    const res = makeRes();

    await getUploadStream(makeReq({ id: upload.id }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(422);
  });
});

describe('GET /api/uploads/:id/stream/key', () => {
  it('serves the key to the owner', async () => {
    const upload = await seedUpload();
    const uploadId = upload.id;
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: uploadId, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const res = makeRes();

    await getUploadStreamKey(makeReq({ id: uploadId }, { userId: OWNER }), res as unknown as Response, rethrow);

    expect(res._status).toBe(200);
    expect(Buffer.isBuffer(res._body)).toBe(true);
    expect(res._headers['Cache-Control']).toBe('no-store');
  });

  it('accepts the owner’s stream token — players cannot set an Authorization header', async () => {
    const upload = await seedUpload();
    const uploadId = upload.id;
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: uploadId, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const token = mintStreamToken({ trackId: uploadId, userId: OWNER, maxBitrateKbps: 160 }, 60);
    const res = makeRes();

    await getUploadStreamKey(
      makeReq({ id: uploadId }, { query: { t: token } }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(200);
  });

  it('refuses a token minted for somebody ELSE', async () => {
    // The token carries the user it was minted for, and the document is loaded by
    // (id, ownerOxyUserId) together — so a stranger's valid token names an owner
    // that matches no document of this file's.
    const upload = await seedUpload();
    const uploadId = upload.id;
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: uploadId, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const token = mintStreamToken({ trackId: uploadId, userId: STRANGER, maxBitrateKbps: 160 }, 60);
    const res = makeRes();

    await getUploadStreamKey(
      makeReq({ id: uploadId }, { query: { t: token } }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
    expect(Buffer.isBuffer(res._body)).toBe(false);
  });

  it('refuses a token minted for a DIFFERENT upload', async () => {
    const mine = await seedUpload();
    const other = await seedUpload();
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: mine.id, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const token = mintStreamToken(
      { trackId: other.id, userId: OWNER, maxBitrateKbps: 160 },
      60,
    );
    const res = makeRes();

    await getUploadStreamKey(
      makeReq({ id: mine.id }, { query: { t: token } }),
      res as unknown as Response,
      rethrow,
    );

    // No session and a token that does not name this id — nothing authorises it.
    expect(res._status).toBe(401);
  });

  it('refuses a stranger’s session', async () => {
    const upload = await seedUpload();
    await getDb().insert(trackKeys).values({ kind: 'user_upload', trackId: upload.id, keyHex: 'ab'.repeat(16), keyUri: 'key' });
    const res = makeRes();

    await getUploadStreamKey(
      makeReq({ id: upload.id }, { userId: STRANGER }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
  });
});

describe('GET /api/uploads/:id/stream/master.m3u8', () => {
  it('points its variants at the LOCKER path, not the catalogue one', async () => {
    const upload = await seedUpload();
    const uploadId = upload.id;
    const res = makeRes();

    await getUploadMasterPlaylist(
      makeReq({ id: uploadId }, { userId: OWNER }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(200);
    const playlist = String(res._body);
    expect(playlist).toContain(`/api/uploads/${uploadId}/stream/v/160.m3u8?t=`);
    expect(playlist).not.toContain('/api/stream/');
  });

  it('answers 404 to a stranger', async () => {
    const upload = await seedUpload();
    const res = makeRes();

    await getUploadMasterPlaylist(
      makeReq({ id: upload.id }, { userId: STRANGER }),
      res as unknown as Response,
      rethrow,
    );

    expect(res._status).toBe(404);
  });
});
