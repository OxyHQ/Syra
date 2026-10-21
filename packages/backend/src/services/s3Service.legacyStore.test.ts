/**
 * Syra's media move from S3 to Cloudflare R2 (OxyHQ/oxy ADR 0047). While they
 * do, R2 is the store and the S3 bucket is the LEGACY store: nothing is written
 * to it, but every delete reaches it too — R2's on-read migration (Sippy) would
 * copy a leftover back, which for a takedown is the difference between removing
 * a work and hiding it — and listings include what only it holds.
 *
 * Each case runs in a fresh process: the stores are chosen when
 * `config/s3.config` loads, from the environment, and a module mock would
 * outlive this file in `bun test`'s shared registry.
 */
import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const R2 = {
  R2_BUCKET: 'syra-media',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secret',
};

type Call = { store: string; name: string; bucket: string; key?: string; keys?: string[] };

/** Run `body` (an async function body) with S3Client.send recorded per store. */
function run(
  env: Record<string, string>,
  body: string,
): { result?: unknown; sent: Call[]; error?: string } {
  const script = `
    const { S3Client } = await import('@aws-sdk/client-s3');
    const sent = [];
    const listings = {
      r2: ['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts'],
      s3: ['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts', 'hls/a/t/seg1.ts'],
    };
    S3Client.prototype.send = async function (command) {
      const store = (await this.config.region()) === 'auto' ? 'r2' : 's3';
      const name = command.constructor.name;
      sent.push({ store, name, bucket: command.input.Bucket, key: command.input.Key,
        keys: command.input.Delete?.Objects?.map((o) => o.Key) });
      if (name === 'ListObjectsV2Command') {
        return { Contents: listings[store].filter((k) => k.startsWith(command.input.Prefix)).map((Key) => ({ Key })) };
      }
      return {};
    };
    const config = await import('./src/config/s3.config.ts');
    const service = await import('./src/services/s3Service.ts');
    const result = await (async () => { ${body} })();
    console.log('RESULT ' + JSON.stringify({ result, sent }));
  `;
  const out = spawnSync('bun', ['-e', script], {
    cwd: path.resolve(__dirname, '../..'),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', ...env },
    encoding: 'utf8',
  });
  const line = out.stdout.split('\n').find((text) => text.startsWith('RESULT '));
  if (!line) return { sent: [], error: out.stderr || out.stdout };
  return JSON.parse(line.slice('RESULT '.length));
}

describe('the legacy store while Syra migrates to R2', () => {
  const env = { ...R2, AWS_S3_BUCKET: 'oxy-syra-media-usw2' };

  it('a delete reaches both stores', () => {
    const { sent } = run(env, `await service.deleteFromS3('audio/a/t.mp3');`);
    expect(sent.map((call) => `${call.store} ${call.name} ${call.bucket} ${call.key}`)).toEqual([
      'r2 DeleteObjectCommand syra-media audio/a/t.mp3',
      's3 DeleteObjectCommand oxy-syra-media-usw2 audio/a/t.mp3',
    ]);
  });

  it('a prefix delete empties the prefix in both, each from its own listing', () => {
    const { result, sent } = run(env, `return service.deleteS3Prefix('hls/a/t/');`);
    expect(result).toBe(2);
    expect(
      sent
        .filter((call) => call.name === 'DeleteObjectsCommand')
        .map((call) => [call.store, call.keys]),
    ).toEqual([
      ['r2', ['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts']],
      ['s3', ['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts', 'hls/a/t/seg1.ts']],
    ]);
  });

  it('a batch delete reaches both', () => {
    const { sent } = run(env, `await service.deleteFromS3Batch(['a', 'b']);`);
    expect(sent.map((call) => call.store)).toEqual(['r2', 's3']);
  });

  it('a listing includes what only the legacy store holds, once', () => {
    const { result } = run(
      env,
      `const keys = []; for await (const key of service.listS3Keys('hls/a/t/')) keys.push(key); return keys.sort();`,
    );
    expect(result).toEqual(['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts', 'hls/a/t/seg1.ts']);
  });

  it('a legacy image is read from S3, never through R2 (Sippy would copy it in)', () => {
    const { sent } = run(
      env,
      `await service.streamFromS3('images/abc/original.jpg').catch(() => {}); await service.getObjectMetadata('images/abc/medium.jpg').catch(() => {}); await service.streamFromS3('hls/a/t/master.m3u8').catch(() => {});`,
    );
    expect(sent.map((call) => `${call.store} ${call.key}`)).toEqual([
      's3 images/abc/original.jpg',
      's3 images/abc/medium.jpg',
      'r2 hls/a/t/master.m3u8',
    ]);
  });

  it('after the migration nothing is mirrored', () => {
    const { sent } = run(R2, `await service.deleteFromS3('k');`);
    expect(sent.map((call) => call.store)).toEqual(['r2']);
  });
});

describe('which store the environment names', () => {
  const describeStore = `return { bucket: config.S3_BUCKET_NAME, region: config.S3_REGION, endpoint: config.S3_ENDPOINT ?? null, legacy: config.legacyStore?.bucket ?? null, static: Boolean(config.store.credentials) };`;

  it('before the cutover: the S3 bucket, with the task role', () => {
    expect(run({ AWS_S3_BUCKET: 'old' }, describeStore).result).toEqual({
      bucket: 'old',
      region: 'us-west-2',
      endpoint: null,
      legacy: null,
      static: false,
    });
  });

  it('during the migration: R2, with the S3 bucket as the legacy store', () => {
    expect(run({ ...R2, AWS_S3_BUCKET: 'old' }, describeStore).result).toEqual({
      bucket: 'syra-media',
      region: 'auto',
      endpoint: R2.R2_ENDPOINT,
      legacy: 'old',
      static: true,
    });
  });

  it('refuses half an R2 configuration', () => {
    expect(run({ R2_BUCKET: 'syra-media', AWS_S3_BUCKET: 'old' }, describeStore).error).toContain(
      'R2_BUCKET is set but',
    );
  });
});
