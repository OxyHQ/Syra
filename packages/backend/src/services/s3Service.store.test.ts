/**
 * Syra's ONE object store. A deployment names Cloudflare R2 (`R2_*`, OxyHQ/oxy
 * ADR 0047) and every write, read, delete and listing goes there and nowhere
 * else; a checkout without `R2_BUCKET` uses a local emulator (MinIO) instead.
 * There is no second store: the S3 bucket R2 was migrated from is retired, and
 * a stale `AWS_S3_BUCKET` on a task definition must not bring it back.
 *
 * Each case runs in a fresh process: the store is chosen when
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

/** What the retired migration set beside R2; it must change nothing now. */
const STALE_S3 = {
  AWS_S3_BUCKET: 'oxy-syra-media-usw2',
  AWS_S3_BUCKET_NAME: 'oxy-syra-media-usw2',
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
    const listing = ['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts', 'hls/a/t/seg1.ts'];
    S3Client.prototype.send = async function (command) {
      const store = (await this.config.region()) === 'auto' ? 'r2' : 'other';
      const name = command.constructor.name;
      sent.push({ store, name, bucket: command.input.Bucket, key: command.input.Key,
        keys: command.input.Delete?.Objects?.map((o) => o.Key) });
      if (name === 'ListObjectsV2Command') {
        // Two pages, so pagination is exercised.
        const matching = listing.filter((k) => k.startsWith(command.input.Prefix));
        const second = command.input.ContinuationToken === 'page-2';
        const page = second ? matching.slice(2) : matching.slice(0, 2);
        return {
          Contents: page.map((Key) => ({ Key, LastModified: new Date(0) })),
          IsTruncated: !second && matching.length > 2,
          NextContinuationToken: second ? undefined : 'page-2',
        };
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

describe('R2 is the only store', () => {
  // A deployment's environment, with the retired S3 bucket still named.
  const env = { ...R2, ...STALE_S3 };

  it('a delete reaches R2 alone', () => {
    const { sent } = run(env, `await service.deleteFromS3('audio/a/t.mp3');`);
    expect(sent.map((call) => `${call.store} ${call.name} ${call.bucket} ${call.key}`)).toEqual([
      'r2 DeleteObjectCommand syra-media audio/a/t.mp3',
    ]);
  });

  it('a prefix delete empties the prefix in R2, page by page, and nothing else', () => {
    const { result, sent } = run(env, `return service.deleteS3Prefix('hls/a/t/');`);
    expect(result).toBe(3);
    expect(sent.every((call) => call.store === 'r2' && call.bucket === 'syra-media')).toBe(true);
    expect(
      sent.filter((call) => call.name === 'DeleteObjectsCommand').map((call) => call.keys),
    ).toEqual([['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts'], ['hls/a/t/seg1.ts']]);
  });

  it('a batch delete reaches R2 alone', () => {
    const { sent } = run(env, `await service.deleteFromS3Batch(['a', 'b']);`);
    expect(sent.map((call) => `${call.store} ${call.bucket}`)).toEqual(['r2 syra-media']);
  });

  it('a listing is R2’s, across pages, each key once', () => {
    const { result, sent } = run(
      env,
      `const keys = []; for await (const key of service.listS3Keys('hls/a/t/')) keys.push(key); return keys;`,
    );
    expect(result).toEqual(['hls/a/t/master.m3u8', 'hls/a/t/seg0.ts', 'hls/a/t/seg1.ts']);
    expect(sent.map((call) => `${call.store} ${call.name}`)).toEqual([
      'r2 ListObjectsV2Command',
      'r2 ListObjectsV2Command',
    ]);
  });

  it('an age listing (the abandoned-upload sweep) is R2’s, with each object’s age', () => {
    const { result, sent } = run(
      env,
      `const out = []; for await (const o of service.listS3Objects('hls/a/t/')) out.push([o.key, o.lastModified instanceof Date]); return out;`,
    );
    expect(result).toEqual([
      ['hls/a/t/master.m3u8', true],
      ['hls/a/t/seg0.ts', true],
      ['hls/a/t/seg1.ts', true],
    ]);
    expect(sent.every((call) => call.store === 'r2')).toBe(true);
  });

  it('every read goes to R2', () => {
    const { sent } = run(
      env,
      `await service.streamFromS3('audio/a/t.mp3').catch(() => {}); await service.getObjectMetadata('previews/t/0.mp3').catch(() => {}); await service.getPresignedUrl('hls/a/t/master.m3u8').catch(() => {});`,
    );
    expect(sent.map((call) => `${call.store} ${call.bucket} ${call.key}`)).toEqual([
      'r2 syra-media audio/a/t.mp3',
      'r2 syra-media previews/t/0.mp3',
    ]);
  });

  it('a direct upload is presigned against R2, with its length and type signed', () => {
    const { result, sent } = run(
      env,
      `const { url, headers } = await service.createPresignedUpload('incoming/track/account/u/x', { contentType: 'audio/mpeg', contentLength: 1234, expiresInSeconds: 60 }); const u = new URL(url); return { host: u.host, path: u.pathname, signed: u.searchParams.get('X-Amz-SignedHeaders'), headers };`,
    );
    expect(result).toEqual({
      host: 'syra-media.acct.r2.cloudflarestorage.com',
      path: '/incoming/track/account/u/x',
      signed: 'content-length;content-type;host',
      headers: { 'Content-Type': 'audio/mpeg' },
    });
    // Signing is local: nothing was sent to the store.
    expect(sent).toEqual([]);
  });
});

describe('which store the environment names', () => {
  const describeStore = `return { exports: Object.keys(config).filter((name) => /store/i.test(name)).sort(), bucket: config.S3_BUCKET_NAME, region: config.S3_REGION, endpoint: config.S3_ENDPOINT ?? null, static: Boolean(config.store.credentials) };`;

  it('a deployment: R2, with its token — and no second store, whatever else is set', () => {
    expect(run({ ...R2, ...STALE_S3 }, describeStore).result).toEqual({
      exports: ['store'],
      bucket: 'syra-media',
      region: 'auto',
      endpoint: R2.R2_ENDPOINT,
      static: true,
    });
  });

  it('a local checkout: the emulator AWS_ENDPOINT_URL and AWS_S3_BUCKET_NAME name', () => {
    expect(
      run(
        {
          AWS_ENDPOINT_URL: 'http://127.0.0.1:19000',
          AWS_S3_BUCKET_NAME: 'syra-e2e',
          AWS_ACCESS_KEY_ID: 'k',
          AWS_SECRET_ACCESS_KEY: 's',
        },
        describeStore,
      ).result,
    ).toEqual({
      exports: ['store'],
      bucket: 'syra-e2e',
      region: 'us-west-2',
      endpoint: 'http://127.0.0.1:19000',
      static: true,
    });
  });

  it('the retired AWS_S3_BUCKET names nothing', () => {
    expect(run({ AWS_S3_BUCKET: 'oxy-syra-media-usw2' }, describeStore).result).toMatchObject({
      bucket: 'syra-audio',
    });
  });

  it('refuses half an R2 configuration', () => {
    expect(run({ R2_BUCKET: 'syra-media', ...STALE_S3 }, describeStore).error).toContain(
      'R2_BUCKET is set but',
    );
  });
});
