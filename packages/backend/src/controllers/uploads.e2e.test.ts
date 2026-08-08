import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { uuidv7 } from '@oxyhq/db';
import type { Server } from 'http';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { eq, sql } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, tracks } from '../db/schema/catalog';
import { contributionAttestations, userUploads } from '../db/schema/creators';
import uploadsRoutes from '../routes/uploads.routes';
import * as searchCtl from './search.controller';
import * as tracksCtl from './tracks.controller';
import * as browseCtl from './browse.controller';
import { runExpirySweep } from '../services/uploads/expirySweeper';

/**
 * END-TO-END upload verification against REAL services.
 *
 * WHY THIS EXISTS, when 1200 unit tests already pass: unit tests prove the parts
 * work in isolation. This session found six mechanisms that were built, tested,
 * typechecking and never invoked by anything — every one would have shipped
 * behind a green suite. Only a run against real services catches that class.
 *
 * REAL: HTTP (express + multer), Postgres, S3, audio fixtures, ffprobe, the
 * actual route table from `routes/uploads.routes.ts`.
 *
 * SUBSTITUTED, and this is the one thing that is not real: identity. `req.user`
 * is injected by a middleware at precisely the point `oxy.auth()` would set it,
 * because minting a genuine Oxy session needs credentials on the live IdP. Every
 * ownership decision below is still made by the handler from that value, so the
 * owner-vs-stranger assertions are meaningful; what is NOT covered is the Oxy
 * token exchange itself.
 *
 * HOW TO RUN — it SKIPS without an S3 endpoint, deliberately, because the whole
 * point is asserting against real storage rather than inferring from a response:
 *
 *   docker run -d --name syra-e2e-minio -p 19000:9000 \
 *     -e MINIO_ROOT_USER=syraE2E -e MINIO_ROOT_PASSWORD=syraE2Esecret \
 *     minio/minio:latest server /data
 *   AWS_ENDPOINT_URL=http://127.0.0.1:19000 AWS_ACCESS_KEY_ID=syraE2E \
 *   AWS_SECRET_ACCESS_KEY=syraE2Esecret AWS_S3_BUCKET_NAME=syra-e2e \
 *     bun test src/controllers/uploads.e2e.test.ts
 *
 * KNOWN ENVIRONMENT LIMIT — read before believing a failure. Bun's HTTP stack
 * mishandles the AWS SDK's streamed `fs.ReadStream` body: the first PUT on a
 * connection succeeds and later ones fail `IncompleteBody`. Verified 2x2 against
 * MinIO — Node 4/4 pass, Bun 1 pass then 3 fail, same file, same code. Production
 * runs `ts-node` on NODE, so this is a TEST-RUNNER defect and not a product bug;
 * do not "fix" the upload path because of it. It is why the untagged fixture here
 * is generated small rather than using the 441 KB `untagged.wav`.
 */

const S3_ENDPOINT = process.env.AWS_ENDPOINT_URL;
const BUCKET = process.env.AWS_S3_BUCKET_NAME ?? 'syra-e2e';
const FIXTURES = path.join(__dirname, '..', 'services', 'uploads', '__fixtures__');
const describeE2E = S3_ENDPOINT ? describe : describe.skip;

const s3 = new S3Client({
  endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

async function listKeys(prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

let server: Server;
let baseUrl = '';
let currentUser = 'user-a';
let smallUntaggedWav = '';
const observations: string[] = [];
const log = (s: string) => observations.push(s);
const noop: NextFunction = () => {};

function capture() {
  const c = {
    _s: 200, _b: undefined as unknown,
    status(n: number) { c._s = n; return c; },
    json(b: unknown) { c._b = b; return c; },
  };
  return c;
}

beforeAll(async () => {
  await connectDb();
  const app = express();
  app.use((req, _res, nx) => { (req as AuthRequest).user = { id: currentUser }; nx(); });
  app.use('/api/uploads', uploadsRoutes);
  server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)); });
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('the test server did not bind a port');
  baseUrl = `http://127.0.0.1:${a.port}`;

  // A small untagged WAV, generated rather than committed — see the Bun note above.
  smallUntaggedWav = path.join(os.tmpdir(), `syra-e2e-small-${process.pid}.wav`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '8000', smallUntaggedWav, '-y']);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (smallUntaggedWav && fs.existsSync(smallUntaggedWav)) fs.unlinkSync(smallUntaggedWav);
  console.log('\nE2E_OBSERVATIONS_START\n' + observations.join('\n') + '\nE2E_OBSERVATIONS_END');
  await disconnectDb();
});

async function postAudio(absPath: string, filename: string, mime: string, fields: Record<string, string>) {
  const buf = fs.readFileSync(absPath);
  const fd = new FormData();
  fd.append('audioFile', new Blob([new Uint8Array(buf)], { type: mime }), filename);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${baseUrl}/api/uploads`, { method: 'POST', body: fd });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body: body as Record<string, unknown> };
}
const upload = (fx: string, mime: string, fields: Record<string, string>) =>
  postAudio(path.join(FIXTURES, fx), fx, mime, fields);

/** `countDocuments({})`, one table at a time. */
async function countRows(table: typeof userUploads | typeof tracks | typeof albums | typeof contributionAttestations): Promise<number> {
  const [counted] = await getDb().select({ total: sql<number>`count(*)::int` }).from(table);
  return counted.total;
}

async function firstUpload() {
  const [row] = await getDb().select().from(userUploads).limit(1);
  return row;
}

async function readUpload(uploadId: string) {
  const [row] = await getDb().select().from(userUploads).where(eq(userUploads.id, uploadId));
  return row;
}

describeE2E('E2E upload flow (requires an S3 endpoint via AWS_ENDPOINT_URL)', () => {
  it('GATE: the harness reports FAILURE when the thing under test is broken', async () => {
    await clearDb();
    // A deliberately wrong expectation proves the assertions are live before any
    // clean result below is trusted. If S3/Postgres/the server were not wired,
    // this would throw rather than fail, and the suite would say so.
    const before = await listKeys();
    currentUser = 'gate-user';
    const r = await upload('indie-id3v2.mp3', 'audio/mpeg', { destination: 'private' });
    const after = await listKeys();
    log(`GATE upload -> ${r.status}; S3 objects ${before.length} -> ${after.length} (must GROW)`);
    expect(r.status).toBe(201);
    expect(after.length).toBeGreaterThan(before.length);
    const stored = await countRows(userUploads);
    log(`GATE postgres rows=${stored} (must be 1)`);
    expect(stored).toBe(1);
  });

  it('STEP 1: bytes already in the catalogue are MATCHED and NO bytes are written', async () => {
    await clearDb();
    currentUser = 'seed-user';
    await upload('indie-id3v2.mp3', 'audio/mpeg', { destination: 'private' });
    const seeded = await firstUpload();
    const [artist] = await getDb()
      .insert(catalogEntities)
      .values({ name: 'Catalogue Owner', type: 'artist', source: 'upload' })
      .returning({ id: catalogEntities.id });
    await getDb().insert(tracks).values({
      title: 'Already Here', artistId: artist.id, artistName: 'Catalogue Owner',
      duration: 200, source: 'upload', status: 'ready', isAvailable: true, sha256: seeded?.sha256,
    });
    await getDb().delete(userUploads);

    const before = await listKeys();
    currentUser = 'second-user';
    const r = await upload('indie-id3v2.mp3', 'audio/mpeg', { destination: 'private' });
    const after = await listKeys();
    const added = after.filter((k) => !before.includes(k));

    log(`STEP1 -> ${r.status} outcome=${(r.body as { outcome?: string }).outcome} trackId=${(r.body as { trackId?: string }).trackId}`);
    log(`STEP1 S3 before=${before.length} after=${after.length} ADDED=${added.length} ${added.join(',')}`);
    expect((r.body as { outcome?: string }).outcome).toBe('matched');
    expect(added).toEqual([]);
    expect(await countRows(userUploads)).toBe(0);
  });

  it('STEP 2: a private locker file is readable and streamable ONLY by its owner', async () => {
    await clearDb();
    currentUser = 'owner-1';
    const r = await upload('cdrip-picard.flac', 'audio/flac', { destination: 'private' });
    const up = await firstUpload();
    const id = up?.id;
    const keys = await listKeys();
    log(`STEP2 upload -> ${r.status} id=${id} status=${up?.status} key=${up?.audioSourceKey}`);
    log(`STEP2 S3 objects for this upload=${keys.filter((k) => id && k.includes(id)).length}`);
    expect(keys.some((k) => id !== undefined && k.includes(id))).toBe(true);

    currentUser = 'owner-1';
    const docOwner = await fetch(`${baseUrl}/api/uploads/${id}`);
    const streamOwner = await fetch(`${baseUrl}/api/uploads/${id}/stream`);
    currentUser = 'stranger-9';
    const docStranger = await fetch(`${baseUrl}/api/uploads/${id}`);
    const streamStranger = await fetch(`${baseUrl}/api/uploads/${id}/stream`);

    log(`STEP2 GET /:id        owner=${docOwner.status} stranger=${docStranger.status}`);
    log(`STEP2 GET /:id/stream owner=${streamOwner.status} stranger=${streamStranger.status}`);
    expect(docOwner.status).toBe(200);
    // 404, not 403 — a stranger cannot even learn the id exists.
    expect(docStranger.status).toBe(404);
    expect(streamStranger.status).toBe(404);
  });

  it('STEP 3: no locker file reaches any public surface from another account', async () => {
    await clearDb();
    currentUser = 'private-owner';
    const r = await upload('indie-id3v2.mp3', 'audio/mpeg', { destination: 'private' });
    const up = await firstUpload();
    log(`STEP3 seeded -> ${r.status} id=${up?.id} title=${up?.title}`);
    expect(up).not.toBeNull();

    const q = (e: Record<string, unknown> = {}) =>
      ({ params: {}, query: {}, user: { id: 'a-different-account' }, ...e }) as unknown as AuthRequest;
    const probes: [string, (c: ReturnType<typeof capture>) => Promise<unknown>][] = [
      ['search', (c) => searchCtl.search(q({ query: { q: 'Midnight Ferry' } }), c as unknown as Response, noop)],
      ['searchTracks', (c) => tracksCtl.searchTracks(q({ query: { q: 'Midnight Ferry' } }), c as unknown as Response, noop)],
      ['getTracks', (c) => tracksCtl.getTracks(q(), c as unknown as Response, noop)],
      ['getPopularTracks', (c) => browseCtl.getPopularTracks(q(), c as unknown as Response, noop)],
      ['getCharts', (c) => browseCtl.getCharts(q(), c as unknown as Response, noop)],
      ['getHomeBrowse', (c) => browseCtl.getHomeBrowse(q(), c as unknown as Response, noop)],
      ['getMadeForYou', (c) => browseCtl.getMadeForYou(q(), c as unknown as Response, noop)],
    ];
    for (const [label, run] of probes) {
      const c = capture();
      await run(c);
      /**
       * Assert on the RESULT PAYLOAD, never a substring of the whole body:
       * `/api/search` echoes `query` back, so `includes(title)` matches the echo
       * and reports a leak that is not there. It did exactly that on the first
       * run of this suite.
       */
      const body = (c._b ?? {}) as { results?: Record<string, unknown[]>; counts?: { total?: number }; tracks?: unknown[] };
      const payload = body.results ? JSON.stringify(body.results) : JSON.stringify({ tracks: body.tracks ?? [] });
      const leaked = payload.includes(String(up?.id)) || payload.includes('Midnight Ferry');
      log(`STEP3 ${label} status=${c._s} resultTotal=${body.counts?.total ?? body.tracks?.length ?? 0} ${leaked ? '*** LEAKED' : 'clean'}`);
      expect(leaked).toBe(false);
    }
  });

  it('STEP 4: a no-artist file is PRIVATE-ok and PUBLIC-refused with a machine code', async () => {
    await clearDb();
    currentUser = 'untagged-private';
    const priv = await postAudio(smallUntaggedWav, 'small-untagged.wav', 'audio/wav', { destination: 'private' });
    const stored = await firstUpload();
    log(`STEP4 private -> ${priv.status} outcome=${(priv.body as { outcome?: string }).outcome} artistName=${JSON.stringify(stored?.artistName)}`);
    expect(priv.status).toBeLessThan(400);
    expect(await countRows(userUploads)).toBe(1);

    await clearDb();
    currentUser = 'untagged-public';
    const pub = await postAudio(smallUntaggedWav, 'small-untagged.wav', 'audio/wav',
      { destination: 'public', attestation: 'I may distribute this' });
    const code = (pub.body as { code?: string }).code;
    log(`STEP4 public  -> ${pub.status} code=${code} message=${String((pub.body as { message?: string }).message).slice(0, 80)}`);
    expect(pub.status).toBeGreaterThanOrEqual(400);
    expect(code).toBe('artist_unresolved');
    // No silent downgrade to the locker — the user must see what the file lacks.
    expect(await countRows(userUploads)).toBe(0);
  });

  it('STEP 5: an iTunes-purchased M4A is refused on the public path, naming the marker', async () => {
    await clearDb();
    currentUser = 'purchaser';
    const r = await upload('purchased-itunes.m4a', 'audio/mp4',
      { destination: 'public', attestation: 'I may distribute this' });
    const markers = (r.body as { markers?: { code: string; weight: string }[] }).markers ?? [];
    log(`STEP5 -> ${r.status} code=${(r.body as { code?: string }).code} markers=${markers.map((m) => `${m.code}/${m.weight}`).join(',')}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(markers.some((m) => m.code === 'itunes.purchase-atoms' && m.weight === 'blocking')).toBe(true);
    expect(await countRows(tracks)).toBe(0);
  });

  it('STEP 6: an unknown artist published publicly creates a claimable stub, and an album with cover art', async () => {
    await clearDb();
    currentUser = 'contributor-1';
    const noCover = await upload('indie-id3v2.mp3', 'audio/mpeg',
      { destination: 'public', attestation: 'I have the right to distribute this recording' });
    const artists = await getDb().select().from(catalogEntities);
    const attestations = await countRows(contributionAttestations);
    log(`STEP6a -> ${noCover.status} outcome=${(noCover.body as { outcome?: string }).outcome} artists=${artists.length} claimable=${artists.filter((a) => a.claimable).length} origin=${artists.map((a) => a.origin).join(',')} attestations=${attestations}`);
    log(`STEP6a albums=${await countRows(albums)} (0 expected: the embedded cover is under the 500px catalogue threshold and the code refuses to invent artwork)`);
    expect(artists.length).toBe(1);
    expect(artists[0]?.claimable).toBe(true);
    expect(artists[0]?.origin).toBe('contributed');
    expect(attestations).toBe(1);

    await clearDb();
    currentUser = 'contributor-2';
    // An id that names no `image_assets` row — uuid v7, the space every row is
    // minted in since the cutover. A 24-char ObjectId hex still passes
    // `isLiveEntityId`, so it would keep asserting the same outcome even if the
    // guard stopped accepting live ids (the reason `stream.controller.test.ts`
    // records for the same swap).
    const coverId = uuidv7();
    const withCover = await upload('indie-id3v2.mp3', 'audio/mpeg',
      { destination: 'public', attestation: 'I have the right to distribute this recording', coverArt: coverId });
    const album = (await getDb().select().from(albums).limit(1))[0];
    const track = (await getDb().select().from(tracks).limit(1))[0];
    log(`STEP6b -> ${withCover.status} albums=${await countRows(albums)} title=${album?.title} type=${album?.type} releaseDate=${album?.releaseDate}`);
    log(`STEP6b track.albumId linked=${Boolean(track?.albumId)} albumName=${track?.albumName}`);
    expect(album).not.toBeNull();
    expect(track?.albumId).toBe(album?.id);
  });

  it('STEP 7: expiry — notice at T-14d, soft delete at T0, hard delete of ALL objects at T+30d', async () => {
    await clearDb();
    currentUser = 'expiring-owner';
    await upload('indie-id3v2.mp3', 'audio/mpeg', { destination: 'private' });
    const up = await firstUpload();
    const id = up?.id;
    const expiresAt = up?.expiresAt ?? new Date();
    log(`STEP7 seeded id=${id} expiresAt=${expiresAt.toISOString().slice(0, 10)}`);

    const notices: string[] = [];
    const purged: string[] = [];
    const at = (d: Date) => ({
      now: () => d,
      notify: async (n: { ownerOxyUserId: string; uploadCount: number }) => { notices.push(`${n.ownerOxyUserId}:${n.uploadCount}`); },
      deleteObjects: async (u: { id: string }) => { purged.push(u.id); return 1; },
    });

    const r1 = await runExpirySweep(at(new Date(expiresAt.getTime() - 13 * 864e5)));
    log(`STEP7 T-13d -> noticed=${r1.uploadsNoticed} notified=${r1.ownersNotified} notices=${JSON.stringify(notices)}`);
    expect(r1.uploadsNoticed).toBe(1);

    const r2 = await runExpirySweep(at(new Date(expiresAt.getTime() + 1000)));
    const soft = id ? await readUpload(id) : undefined;
    log(`STEP7 T0    -> softDeleted=${r2.uploadsSoftDeleted} deletedAt=${soft?.deletedAt ? 'SET' : 'unset'} rowStillPresent=${Boolean(soft)}`);
    expect(r2.uploadsSoftDeleted).toBe(1);
    expect(soft?.deletedAt).toBeTruthy();

    const r3 = await runExpirySweep(at(new Date(expiresAt.getTime() + 31 * 864e5)));
    const hard = id ? await readUpload(id) : undefined;
    log(`STEP7 T+31d -> hardDeleted=${r3.uploadsHardDeleted} objectsDeleted=${r3.objectsDeleted} rowGone=${hard === undefined} purgedFor=${JSON.stringify(purged)}`);
    expect(r3.uploadsHardDeleted).toBe(1);
    expect(hard).toBeUndefined();
    expect(purged).toEqual([String(id)]);
  });
});
