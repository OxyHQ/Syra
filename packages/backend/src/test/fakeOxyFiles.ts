import type { RequesterProof, ServerAssetsApi } from '@oxy.so/core/server';
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
 * - reconciliation adds the listed pairs it may hold and removes the stale ones;
 * - stage 4c ({@link FakeOxyFiles.audio}): audio is stored (else 415, as an Oxy
 *   without stage 4c answers), a person's file may be private, the application
 *   may read what it stored for a person, a play session needs a rendered ladder
 *   ({@link FakeOxyFiles.renderLadder}; else 409 `STREAM_NOT_READY`), and a
 *   recording target becomes a file once something is "written" into it
 *   ({@link FakeOxyFiles.writeRecording}). With `audio = false` every 4c route
 *   answers 404, like an API that does not serve it yet.
 *
 * Nothing here talks to a network. Bytes an import "downloads" come from
 * {@link FakeOxyFiles.remote}; a missing URL fails the import like an
 * unreachable source.
 */

import { createHash } from 'node:crypto';
import { uuidv7 } from '@oxy.so/db';
import { readFile } from 'node:fs/promises';
import type {
  ApplicationFile,
  ApplicationFileImport,
  ApplicationFileImportBatchResult,
  CreatedRecordingTarget,
  PlaySession,
  PlaySessionOptions,
  PlaySessionState,
  RecordingTarget,
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
  withRequester(proof: RequesterProof): ServerAssetsApi {
    this.record('withRequester', [proof]);
    // Tests exercise this narrow facade through its actual Files methods.
    return this as unknown as ServerAssetsApi;
  }

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
  /** Whether this Oxy serves stage 4c (audio, private person media, streams, recordings). */
  audio = true;
  /** Files whose audio ladder Oxy has rendered (`hlsReadyAt`). */
  readonly ladders = new Set<string>();
  /** A person's files this application stored for them (its consent to read them). */
  readonly storedFor = new Set<string>();
  /** Play sessions, by id. */
  readonly sessions = new Map<string, PlaySessionState>();
  /** Recording targets, by id. */
  readonly targets = new Map<string, RecordingTarget<ApplicationFile>>();

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
    const media =
      mime.startsWith('image/') ||
      mime.startsWith('video/') ||
      (this.audio && mime.startsWith('audio/'));
    if (!media || mime.startsWith('image/svg')) {
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
    return this.importOne(sourceUrl, options);
  }

  private async importOne(
    sourceUrl: string,
    options: FileImportOptions & { visibility: FileVisibility },
  ): Promise<ApplicationFileImport> {
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

  /**
   * Oxy's batch import: each item answers on its own, in order — a refusal is
   * `{ ok: false, error }` for that item, never the call's failure.
   */
  async importAppFiles(
    items: Array<FileImportOptions & { sourceUrl: string; visibility: FileVisibility }>,
  ): Promise<ApplicationFileImportBatchResult[]> {
    this.record('importAppFiles', [items.length]);
    if (items.length > 50) throw new FakeOxyError(400, 'items must be an array of at most 50');
    const results: ApplicationFileImportBatchResult[] = [];
    for (const [index, { sourceUrl, ...options }] of items.entries()) {
      try {
        results.push({ index, ok: true, ...(await this.importOne(sourceUrl, options)) });
      } catch (error) {
        const status = error instanceof FakeOxyError ? error.status : 500;
        const message = error instanceof Error ? error.message : String(error);
        results.push({ index, ok: false, error: { status, code: message, message } });
      }
    }
    return results;
  }

  async uploadUserMedia(
    ownerUserId: string,
    bytes: Uint8Array | ArrayBuffer | Blob,
    mime: string,
    options: { visibility?: FileVisibility } = {},
  ): Promise<ServiceUserMediaFile> {
    this.record('uploadUserMedia', [ownerUserId, mime, options]);
    if (!this.localUsers.has(ownerUserId)) {
      throw new FakeOxyError(403, 'User media owner must be an existing local user');
    }
    // Before stage 4c the route took no visibility: every file was public.
    const visibility = this.audio ? (options.visibility ?? 'public') : 'public';
    const { file } = this.store(toBuffer(bytes), mime, { userId: ownerUserId }, visibility);
    this.storedFor.add(file.id);
    return {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      visibility: file.visibility,
    };
  }

  private async largeSource(source: unknown): Promise<Buffer> {
    if (typeof source === 'string') return readFile(source);
    return toBuffer(source as Uint8Array | ArrayBuffer | Blob);
  }

  async uploadAppFileLarge(
    source: unknown,
    options: {
      mime: string;
      visibility: FileVisibility;
      reference?: { entityType: string; entityId: string };
    },
  ) {
    this.record('uploadAppFileLarge', [options]);
    const { file, deduplicated } = this.store(
      await this.largeSource(source),
      options.mime,
      { applicationId: this.applicationId },
      options.visibility,
    );
    if (options.reference) await this.references.add([{ fileId: file.id, ...options.reference }]);
    return { file: this.appFile(file), deduplicated, uploadId: deduplicated ? null : uuidv7() };
  }

  async uploadUserMediaLarge(
    ownerUserId: string,
    source: unknown,
    options: {
      mime: string;
      visibility?: FileVisibility;
      reference?: { entityType: string; entityId: string };
    },
  ) {
    this.record('uploadUserMediaLarge', [ownerUserId, options]);
    if (!this.localUsers.has(ownerUserId)) {
      throw new FakeOxyError(403, 'User media owner must be an existing local user');
    }
    const { file, deduplicated } = this.store(
      await this.largeSource(source),
      options.mime,
      { userId: ownerUserId },
      options.visibility ?? 'public',
    );
    this.storedFor.add(file.id);
    if (options.reference) await this.references.add([{ fileId: file.id, ...options.reference }]);
    return {
      file: {
        id: file.id,
        sha256: file.sha256,
        size: file.size,
        mime: file.mime,
        visibility: file.visibility,
        status: file.status,
      },
      deduplicated,
      uploadId: deduplicated ? null : uuidv7(),
    };
  }

  /** Oxy finished rendering a file's audio ladder. */
  renderLadder(fileId: string): void {
    this.ladders.add(fileId);
  }

  /** Whether this application may read `file` with its service token (stage 4c consent). */
  private mayRead(file: FakeFile | undefined): boolean {
    if (!file || file.status !== 'active') return false;
    return file.ownerApplicationId === this.applicationId || this.storedFor.has(file.id);
  }

  private require4c(route: string): void {
    if (!this.audio) throw new FakeOxyError(404, `Cannot POST ${route}`);
  }

  readonly streams = {
    create: async (fileId: string, options: PlaySessionOptions = {}): Promise<PlaySession> => {
      this.record('streams.create', [fileId, options]);
      this.require4c('/assets/service/streams');
      const file = this.files.get(fileId);
      if (!this.mayRead(file))
        throw Object.assign(new FakeOxyError(404, 'Not found'), { code: 'NOT_FOUND' });
      if (!this.ladders.has(fileId)) {
        throw Object.assign(new FakeOxyError(409, 'No ladder yet'), { code: 'STREAM_NOT_READY' });
      }
      const sessionId = uuidv7();
      const state: PlaySessionState = {
        sessionId,
        fileId,
        kind: 'audio',
        status: 'active',
        encryption: options.encryption ?? 'aes-128',
        keyAuthorization: options.keyAuthorization ?? 'none',
        endUserId: options.endUserId ?? null,
        expiresAt: new Date(Date.now() + (options.ttlSeconds ?? 3600) * 1000).toISOString(),
      };
      this.sessions.set(sessionId, state);
      const base = `https://api.oxy.test/assets/streams/${sessionId}.secret`;
      return {
        ...state,
        masterUrl: `${base}/master.m3u8`,
        // Like Oxy: a session opened with a rendition list carries only those rungs.
        renditions: [64, 128, 256]
          .filter(
            (kbps) =>
              !options.renditions ||
              (options.renditions as readonly string[]).includes(`hls_a${kbps}`),
          )
          .map((kbps) => ({
            type: `hls_a${kbps}`,
            url: `${base}/hls_a${kbps}/index.m3u8`,
            bandwidth: kbps * 1000,
          })),
        previewUrl: `${base}/preview.m4a`,
        waveformUrl: `${base}/waveform.json`,
      };
    },
    get: async (sessionId: string): Promise<PlaySessionState> => {
      const state = this.sessions.get(sessionId);
      if (!state) throw new FakeOxyError(404, 'Not found');
      return state;
    },
    revoke: async (sessionId: string): Promise<{ sessionId: string; revoked: true }> => {
      const state = this.sessions.get(sessionId);
      if (state) state.status = 'revoked';
      return { sessionId, revoked: true };
    },
    revokeWhere: async (filter: { fileId?: string; endUserId?: string }) => {
      this.record('streams.revokeWhere', [filter]);
      this.require4c('/assets/service/streams/revoke');
      let revoked = 0;
      for (const state of this.sessions.values()) {
        if (state.status !== 'active') continue;
        if (filter.fileId && state.fileId !== filter.fileId) continue;
        if (filter.endUserId && state.endUserId !== filter.endUserId) continue;
        state.status = 'revoked';
        revoked += 1;
      }
      return { revoked };
    },
  };

  async linkedDownloadUrls(ids: string[]): Promise<
    Array<{
      id: string;
      url: string;
      expiresIn: number;
      mime: string;
      size: number;
      sha256: string;
    }>
  > {
    this.record('linkedDownloadUrls', [ids]);
    return ids
      .map((id) => this.files.get(id))
      .filter((file): file is FakeFile => this.mayRead(file))
      .map((file) => ({
        id: file.id,
        url: `https://download.oxy.test/${file.id}?sig=x`,
        expiresIn: 300,
        mime: file.mime,
        size: file.size,
        sha256: file.sha256,
      }));
  }

  async createAppRecordingTarget(options: {
    visibility: FileVisibility;
    filename?: string;
    reference?: { entityType: string; entityId: string };
    expiresInSeconds?: number;
  }): Promise<CreatedRecordingTarget> {
    this.record('createAppRecordingTarget', [options]);
    this.require4c('/assets/service/app/recording-targets');
    const targetId = `target-${uuidv7()}`;
    const expiresAt = new Date(
      Date.now() + (options.expiresInSeconds ?? 86_400) * 1000,
    ).toISOString();
    this.targets.set(targetId, { targetId, status: 'awaiting_upload', expiresAt });
    this.targetOptions.set(targetId, options);
    const filepath = `${targetId}/${options.filename ?? 'recording.ogg'}`;
    const s3 = {
      accessKey: targetId,
      secret: 'target-secret',
      region: 'us-east-1',
      endpoint: 'https://api.oxy.test/assets/recording-ingest',
      bucket: 'oxy-recordings',
      forcePathStyle: true as const,
    };
    return {
      targetId,
      status: 'awaiting_upload',
      expiresAt,
      filepath,
      s3,
      livekit: {
        filepath,
        s3: {
          access_key: s3.accessKey,
          secret: s3.secret,
          region: s3.region,
          endpoint: s3.endpoint,
          bucket: s3.bucket,
          force_path_style: true,
        },
      },
    };
  }

  private readonly targetOptions = new Map<
    string,
    { visibility: FileVisibility; reference?: { entityType: string; entityId: string } }
  >();

  /** LiveKit egress finished writing a recording into a target; Oxy verified it. */
  async writeRecording(targetId: string, bytes: Buffer, mime = 'audio/ogg'): Promise<string> {
    const target = this.targets.get(targetId);
    const options = this.targetOptions.get(targetId);
    if (!target || !options) throw new Error(`No target ${targetId}`);
    const { file, deduplicated } = this.store(
      bytes,
      mime,
      { applicationId: this.applicationId },
      options.visibility,
    );
    if (options.reference) await this.references.add([{ fileId: file.id, ...options.reference }]);
    this.targets.set(targetId, {
      ...target,
      status: 'completed',
      size: file.size,
      file: this.appFile(file),
      deduplicated,
    });
    return file.id;
  }

  async getRecordingTarget(targetId: string): Promise<RecordingTarget<ApplicationFile>> {
    this.record('getRecordingTarget', [targetId]);
    this.require4c('/assets/service/app/recording-targets');
    const target = this.targets.get(targetId);
    if (!target) throw new FakeOxyError(404, 'Not found');
    return target;
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
        ...(this.ladders.has(file.id) ? { hlsReadyAt: new Date(0).toISOString() } : {}),
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
    if (file.status === 'active' && this.storedFor.has(file.id)) return true;
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
