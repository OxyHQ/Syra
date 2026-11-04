/** Oxy Files uses the same workload identity as the rest of Syra.
 * App-owned media and live application references use domain authority;
 * personal writes additionally require the original requester proof.
 */

import { Readable } from 'node:stream';
import { readResponseBody, type ServerAssetsApi } from '@oxy.so/core/server';
import { oxy } from '../../oxyClient';

/** What Syra uses of `OxyServer.assets`. Narrow on purpose: a test double implements exactly this. */
export type OxyFilesApi = Pick<
  ServerAssetsApi,
  | 'withRequester'
  | 'uploadAppFile'
  | 'importAppFile'
  // Batch import (50 URLs a call): what the image migration copies sets with.
  | 'importAppFiles'
  | 'uploadUserMedia'
  | 'metadataByIds'
  | 'metadataBySha256'
  | 'references'
  | 'publicUrl'
  // Audio (ADR 0043 stage 4c), through `oxyAudio.ts` only.
  | 'uploadAppFileLarge'
  | 'uploadUserMediaLarge'
  | 'streams'
  | 'linkedDownloadUrls'
  | 'createAppRecordingTarget'
  | 'getRecordingTarget'
>;

/** Reads a public Oxy file's bytes back — what Syra measures an imported image with. */
export type OxyFileReader = (fileId: string) => Promise<Buffer>;

let override: OxyFilesApi | null = null;
let readerOverride: OxyFileReader | null = null;
export function oxyFiles(): OxyFilesApi {
  return override ?? oxy.assets;
}

/** Swap the client (and the byte reader) for doubles; `null` restores the real ones. */
export function setOxyFilesForTests(
  api: OxyFilesApi | null,
  reader: OxyFileReader | null = null,
): void {
  override = api;
  readerOverride = reader;
}

/** Bounds on reading a file back from Oxy. */
const READ_BACK_TIMEOUT_MS = 30_000;
const READ_BACK_MAX_BYTES = 40 * 1024 * 1024;

/**
 * The bytes of a PUBLIC Oxy file, from its public URL — Oxy's CDN, the one
 * host this ever reads from, so it is not a second fetcher of untrusted URLs.
 * Bounded like Oxy's own uploads (40 MiB): `readResponseBody` stops at the cap
 * as the bytes arrive, so an oversized or undeclared body is never buffered
 * whole, and one deadline covers the response and its body.
 */
export async function readOxyFile(fileId: string): Promise<Buffer> {
  if (readerOverride) return readerOverride(fileId);
  const response = await fetch(oxyFileUrl(fileId), {
    signal: AbortSignal.timeout(READ_BACK_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Reading Oxy file ${fileId} failed with status ${response.status}`);
  }
  const read = await readResponseBody(Readable.from(response.body), {
    maxBytes: READ_BACK_MAX_BYTES,
    timeoutMs: READ_BACK_TIMEOUT_MS,
  });
  switch (read.kind) {
    case 'ok':
      return read.body;
    case 'too_large':
      throw new Error(`Oxy file ${fileId} is too large to read`);
    case 'timeout':
      throw new Error(`Reading Oxy file ${fileId} timed out`);
    case 'error':
      throw new Error(`Reading Oxy file ${fileId} failed: ${read.error.message}`);
  }
}

/**
 * The URL a public Oxy file (or one of its renditions) is served at.
 *
 * Built by the SDK (`assets.publicUrl`), never spelled out here: the CDN host is
 * Oxy's to decide.
 */
export function oxyFileUrl(fileId: string, variant?: string | null): string {
  return oxyFiles().publicUrl(fileId, variant ?? undefined);
}
