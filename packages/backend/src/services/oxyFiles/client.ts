/**
 * The Oxy Files client Syra stores and references files with (OxyHQ/oxy ADR 0043).
 *
 * Every call here is made AS SYRA — a service token, never a user's — because
 * every one of them is Syra's own act: storing catalogue artwork Syra owns,
 * storing a person's upload into their account, and telling Oxy which files
 * Syra uses. The scopes it needs are `files:app:write`, `files:app:delete`,
 * `files:references:write`, `files:user-media:write` and `files:read`
 * (`docs/runbooks/oxy-files-images.md`).
 *
 * A dedicated `OxyServer`, not `oxyClient.ts`'s shared `oxy`: that one carries
 * no configured credential (its callers pass a pair per call), and a file call
 * goes through the SDK's service lane, which needs one configured — or, with
 * none, mints from the task role's workload identity (oxy ADR 0026), exactly
 * as `oxyServiceCredential()` describes.
 *
 * Tests replace it with {@link setOxyFilesForTests}; nothing else should.
 */

import { OxyServer } from '@oxy.so/core/server';
import type { ServerAssetsApi } from '@oxy.so/core/server';
import { oxyServiceCredential } from '../../oxyClient';

/** What Syra uses of `OxyServer.assets`. Narrow on purpose: a test double implements exactly this. */
export type OxyFilesApi = Pick<
  ServerAssetsApi,
  | 'uploadAppFile'
  | 'importAppFile'
  | 'uploadUserMedia'
  | 'metadataByIds'
  | 'metadataBySha256'
  | 'references'
  | 'publicUrl'
>;

const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';

/** Reads a public Oxy file's bytes back — what Syra measures an imported image with. */
export type OxyFileReader = (fileId: string) => Promise<Buffer>;

let override: OxyFilesApi | null = null;
let readerOverride: OxyFileReader | null = null;
let server: OxyServer | null = null;

export function oxyFiles(): OxyFilesApi {
  if (override) return override;
  if (!server) {
    const credential = oxyServiceCredential();
    server = new OxyServer({
      baseURL: OXY_API_URL,
      ...(credential ? { serviceAuth: credential } : {}),
    });
  }
  return server.assets;
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
 * Bounded like Oxy's own uploads (40 MiB).
 */
export async function readOxyFile(fileId: string): Promise<Buffer> {
  if (readerOverride) return readerOverride(fileId);
  const response = await fetch(oxyFileUrl(fileId), {
    signal: AbortSignal.timeout(READ_BACK_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Reading Oxy file ${fileId} failed with status ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > READ_BACK_MAX_BYTES) throw new Error(`Oxy file ${fileId} is too large to read`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > READ_BACK_MAX_BYTES)
    throw new Error(`Oxy file ${fileId} is too large to read`);
  return bytes;
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
