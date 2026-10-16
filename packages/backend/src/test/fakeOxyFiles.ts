/**
 * An in-memory Oxy Files, installed with {@link installFakeOxyFiles}.
 *
 * It keeps the rules of the real service (OxyHQ/oxy ADR 0043) that Syra's code
 * depends on, so a test exercises the decision rather than a stub's echo:
 *
 * - one live file per (owner, SHA-256): the same bytes for the same owner are the
 *   same file (`deduplicated`), for another owner a new one;
 * - an import of a URL the application imported before answers the same file
 *   without "fetching" (`outcome: 'existing'`);
 * - a reference may name the application's own file or any public/unlisted
 *   file; anything else is `not_found`; a removal of a reference Oxy does not
 *   hold is `not_found` too;
 * - reconciliation adds the listed pairs it may hold and removes the stale ones.
 *
 * Nothing here talks to a network. Bytes an import "downloads" come from
 * {@link FakeOxyFiles.remote}; a missing URL fails the import like an
 * unreachable source.
 */

import { createHash } from 'node:crypto';
import { uuidv7 } from '@oxy.so/db';
import type {
  ApplicationFileImport,
  ApplicationFileUpload,
  FileImportOptions,
  FileVisibility,
  ServiceAssetMetadata,
  ServiceAssetMetadataBySha,
  ServiceFileReference,
  ServiceFileReferenceResult,
  ServiceReferenceInventoryItem,
  ServiceReferenceReconcileResult,
  ServiceUserMediaFile,
} from '@oxy.so/core';
import { setOxyFilesForTests, type OxyFilesApi } from '../services/oxyFiles/client';

export const FAKE_SYRA_APPLICATION_ID = 'app-syra';

export interface FakeFile {
  id: string;
  sha256: string;
  size: number;
  mime: string;
  bytes: Buffer;
  ownerApplicationId?: string;
  ownerUserId?: string;
  visibility: FileVisibility;
  status: 'active' | 'trash';
  createdAt: number;
}

/** A failure shaped like the SDK's HTTP errors (`status` on the error). */
export class FakeOxyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBuffer(bytes: Uint8Array | ArrayBuffer | Blob): Buffer {
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  throw new Error('FakeOxyFiles: Blob uploads are not used by Syra');
}

export class FakeOxyFiles implements OxyFilesApi {
  readonly files = new Map<string, FakeFile>();
  /** `fileId|entityType|entityId` → when it was created. */
  readonly refs = new Map<string, number>();
  readonly sources = new Map<string, string>();
  /** What an import of each URL downloads. */
  readonly remote = new Map<string, { bytes: Buffer; mime: string }>();
  /** Local accounts `uploadUserMedia` accepts; anyone else is refused like Oxy's 403. */
  readonly localUsers = new Set<string>();
  /** Every call, by method, for assertions. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** The next call to these methods throws this error once. */
  readonly failNext = new Map<string, Error>();

  private clock = 1;

  constructor(readonly applicationId = FAKE_SYRA_APPLICATION_ID) {}

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      throw failure;
    }
  }

  private store(
    bytes: Buffer,
    mime: string,
    owner: { applicationId?: string; userId?: string },
    visibility: FileVisibility,
  ): { file: FakeFile; deduplicated: boolean } {
    if (!(mime.startsWith('image/') || mime.startsWith('video/')) || mime.startsWith('image/svg')) {
      throw new FakeOxyError(415, `Unsupported media type ${mime}`);
    }
    const digest = sha(bytes);
    for (const file of this.files.values()) {
      if (
        file.sha256 === digest &&
        file.ownerApplicationId === owner.applicationId &&
        file.ownerUserId === owner.userId
      ) {
        return { file, deduplicated: true };
      }
    }
    const file: FakeFile = {
      id: uuidv7(),
      sha256: digest,
      size: bytes.length,
      mime,
      bytes,
      ...(owner.applicationId ? { ownerApplicationId: owner.applicationId } : {}),
      ...(owner.userId ? { ownerUserId: owner.userId } : {}),
      visibility,
      status: 'active',
      createdAt: this.clock++,
    };
    this.files.set(file.id, file);
    return { file, deduplicated: false };
  }

  /** Put a file straight into the store, as another owner would have. */
  seedFile(input: {
    bytes: Buffer;
    mime?: string;
    ownerApplicationId?: string;
    ownerUserId?: string;
    visibility?: FileVisibility;
  }): FakeFile {
    return this.store(
      input.bytes,
      input.mime ?? 'image/png',
      { applicationId: input.ownerApplicationId, userId: input.ownerUserId },
      input.visibility ?? 'public',
    ).file;
  }

  private appFile(file: FakeFile) {
    return {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      ext: file.mime.split('/')[1] ?? 'bin',
      ownerApplicationId: file.ownerApplicationId ?? '',
      status: file.status,
      visibility: file.visibility,
      createdAt: new Date(file.createdAt).toISOString(),
      updatedAt: new Date(file.createdAt).toISOString(),
    };
  }

  async uploadAppFile(
    bytes: Uint8Array | ArrayBuffer | Blob,
    mime: string,
    options: { visibility: FileVisibility },
  ): Promise<ApplicationFileUpload> {
    this.record('uploadAppFile', [mime, options]);
    const { file, deduplicated } = this.store(
      toBuffer(bytes),
      mime,
      { applicationId: this.applicationId },
      options.visibility,
    );
    return { file: this.appFile(file), deduplicated };
  }

  async importAppFile(
    sourceUrl: string,
    options: FileImportOptions & { visibility: FileVisibility },
  ): Promise<ApplicationFileImport> {
    this.record('importAppFile', [sourceUrl, options]);
    if (!sourceUrl.startsWith('https://')) {
      throw new FakeOxyError(422, 'SOURCE_URL_REFUSED');
    }
    const known = this.sources.get(sourceUrl);
    const knownFile = known ? this.files.get(known) : undefined;
    if (knownFile && knownFile.status === 'active' && !options.revalidate) {
      return {
        file: this.appFile(knownFile),
        outcome: 'existing',
        deduplicated: true,
        source: { host: new URL(sourceUrl).host, fetchedAt: new Date().toISOString() },
      };
    }
    const remote = this.remote.get(sourceUrl);
    if (!remote) throw new FakeOxyError(502, 'SOURCE_FETCH_FAILED');
    const { file, deduplicated } = this.store(
      remote.bytes,
      remote.mime,
      { applicationId: this.applicationId },
      options.visibility,
    );
    this.sources.set(sourceUrl, file.id);
    let reference: ApplicationFileImport['reference'];
    if (options.reference) {
      const [result] = await this.references.add([{ fileId: file.id, ...options.reference }]);
      reference = { result: result.result as 'created' | 'exists' | 'not_found' };
    }
    return {
      file: this.appFile(file),
      outcome: knownFile && knownFile.id === file.id ? 'not_modified' : 'downloaded',
      deduplicated,
      source: { host: new URL(sourceUrl).host, fetchedAt: new Date().toISOString() },
      ...(reference ? { reference } : {}),
    };
  }

  async uploadUserMedia(
    ownerUserId: string,
    bytes: Uint8Array | ArrayBuffer | Blob,
    mime: string,
  ): Promise<ServiceUserMediaFile> {
    this.record('uploadUserMedia', [ownerUserId, mime]);
    if (!this.localUsers.has(ownerUserId)) {
      throw new FakeOxyError(403, 'User media owner must be an existing local user');
    }
    const { file } = this.store(toBuffer(bytes), mime, { userId: ownerUserId }, 'public');
    return {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      visibility: 'public',
    };
  }

  async metadataByIds(ids: string[]): Promise<ServiceAssetMetadata[]> {
    this.record('metadataByIds', [ids]);
    return ids
      .map((id) => this.files.get(id))
      .filter((file): file is FakeFile => file !== undefined)
      .map((file) => ({
        id: file.id,
        sha256: file.sha256,
        mime: file.mime,
        size: file.size,
        status: file.status,
        ownerUserId: file.ownerUserId ?? null,
        ...(file.ownerApplicationId ? { ownerApplicationId: file.ownerApplicationId } : {}),
      }));
  }

  async metadataBySha256(sha256s: string[]): Promise<ServiceAssetMetadataBySha[]> {
    this.record('metadataBySha256', [sha256s]);
    const out: ServiceAssetMetadataBySha[] = [];
    for (const digest of sha256s) {
      const oldest = [...this.files.values()]
        .filter((file) => file.sha256 === digest)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        out.push({
          sha256: digest,
          id: oldest.id,
          mime: oldest.mime,
          size: oldest.size,
          status: oldest.status,
        } as ServiceAssetMetadataBySha);
      }
    }
    return out;
  }

  publicUrl(fileId: string, variant?: string): string {
    return `https://cloud.test/${fileId}${variant ? `?variant=${variant}` : ''}`;
  }

  /** Whether this application may reference `file` (ADR 0043 D4, as Syra meets it). */
  private mayReference(file: FakeFile | undefined): boolean {
    if (!file) return false;
    if (file.ownerApplicationId === this.applicationId) return true;
    return (
      file.status === 'active' && (file.visibility === 'public' || file.visibility === 'unlisted')
    );
  }

  private key(ref: ServiceFileReference): string {
    return `${ref.fileId}|${ref.entityType}|${ref.entityId}`;
  }

  hasReference(fileId: string, entityType: string, entityId: string): boolean {
    return this.refs.has(`${fileId}|${entityType}|${entityId}`);
  }

  readonly references = {
    add: async (references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]> => {
      this.record('references.add', [references]);
      return references.map((ref) => {
        if (!this.mayReference(this.files.get(ref.fileId))) return { ...ref, result: 'not_found' };
        const key = this.key(ref);
        if (this.refs.has(key)) return { ...ref, result: 'exists' };
        this.refs.set(key, this.clock++);
        return { ...ref, result: 'created' };
      });
    },
    remove: async (references: ServiceFileReference[]): Promise<ServiceFileReferenceResult[]> => {
      this.record('references.remove', [references]);
      return references.map((ref) => {
        const key = this.key(ref);
        if (!this.refs.has(key)) return { ...ref, result: 'not_found' };
        this.refs.delete(key);
        return { ...ref, result: 'removed' };
      });
    },
    reconcile: async (
      entityType: string,
      items: Iterable<ServiceReferenceInventoryItem> | AsyncIterable<ServiceReferenceInventoryItem>,
      options: { dryRun?: boolean } = {},
    ): Promise<ServiceReferenceReconcileResult> => {
      this.record('references.reconcile', [entityType, options]);
      const began = this.clock++;
      const listed = new Set<string>();
      let added = 0;
      let unchanged = 0;
      let refused = 0;
      for await (const item of items) {
        const key = this.key({ fileId: item.fileId, entityType, entityId: item.entityId });
        if (listed.has(key)) continue;
        listed.add(key);
        if (this.refs.has(key)) {
          unchanged += 1;
        } else if (!this.mayReference(this.files.get(item.fileId))) {
          refused += 1;
        } else {
          added += 1;
          if (!options.dryRun) this.refs.set(key, this.clock++);
        }
      }
      let removed = 0;
      for (const [key, createdAt] of [...this.refs.entries()]) {
        const [, type] = key.split('|');
        if (type !== entityType || listed.has(key) || createdAt > began) continue;
        removed += 1;
        if (!options.dryRun) this.refs.delete(key);
      }
      return {
        sessionId: 'session',
        entityType,
        dryRun: options.dryRun === true,
        added,
        removed,
        unchanged,
        refused,
      };
    },
  };

  /** The bytes of a file, as Oxy's CDN would serve them. */
  async read(fileId: string): Promise<Buffer> {
    const file = this.files.get(fileId);
    if (!file || file.status !== 'active') throw new FakeOxyError(404, 'Not found');
    return file.bytes;
  }
}

/** Install a fresh fake as Syra's Oxy Files client; returns it. */
export function installFakeOxyFiles(applicationId = FAKE_SYRA_APPLICATION_ID): FakeOxyFiles {
  const fake = new FakeOxyFiles(applicationId);
  setOxyFilesForTests(fake, (fileId) => fake.read(fileId));
  return fake;
}

/** Restore the real client. */
export function resetOxyFiles(): void {
  setOxyFilesForTests(null);
}
