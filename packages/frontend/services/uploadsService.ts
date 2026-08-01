import { Platform } from 'react-native';
import { z } from 'zod';
import {
  uploadOutcomeSchema,
  userUploadAsTrackSchema,
  type UpdateUserUploadRequest,
  type UploadDestination,
  type UploadOutcome,
  type UserUploadAsTrack,
} from '@syra/shared-types';
import { api } from '@/utils/api';
import { normalizeTrackImages, resolveCatalogImageUrl } from '@/utils/catalogImages';

/**
 * The listener's own uploads — the private locker, and the door to the catalogue.
 *
 * Two things about this API shape the whole module:
 *
 * 1. **The server extracts the metadata, not the client.** There is no
 *    extract-only endpoint: `POST /uploads` reads the tags with `ffprobe` and
 *    `music-metadata`, dedups, screens and routes in one request. So the fields
 *    sent alongside the file are OVERRIDES of what the file declares — omitting
 *    one means "keep the tag", never "clear it" — and the reviewable metadata
 *    only exists once the response comes back.
 * 2. **A refusal is a normal outcome, not a transport failure.** The public path
 *    answers 403/404/422 with a `blocked` {@link UploadOutcome} in the body, so
 *    the HTTP client throws on exactly the responses the uploader most needs
 *    explained. {@link blockedOutcomeFromError} pulls that body back out; a
 *    thrown error with no outcome in it is a real failure and is re-thrown.
 */

/** Uploads move whole files; the API client's 5s default would abort every one. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const uploadListResponseSchema = z.object({
  uploads: z.array(userUploadAsTrackSchema),
  total: z.number(),
  hasMore: z.boolean(),
});
export type UploadListResponse = z.infer<typeof uploadListResponseSchema>;

/**
 * One release in the locker, as `GET /api/uploads/albums` aggregates it.
 *
 * Declared here rather than imported: the locker has no `Album` collection, so
 * this shape exists only as that endpoint's response and has no counterpart in
 * `@syra/shared-types`. Parsed at the boundary like every other read.
 *
 * `trackIds` arrives already ordered by disc then track number — the server sorts
 * it on the index it aggregates over, so re-sorting on the client would only be
 * a second, weaker implementation of the same order.
 */
const uploadAlbumSchema = z.object({
  albumKey: z.string(),
  albumName: z.string().optional(),
  albumArtistName: z.string().optional(),
  year: z.number().optional(),
  coverArt: z.string().optional(),
  trackCount: z.number(),
  totalDuration: z.number(),
  trackIds: z.array(z.string()),
});
export type UploadAlbum = z.infer<typeof uploadAlbumSchema>;

const uploadAlbumsResponseSchema = z.object({
  albums: z.array(uploadAlbumSchema),
  total: z.number(),
});
export type UploadAlbumsResponse = z.infer<typeof uploadAlbumsResponseSchema>;

function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid ${label} response: ${result.error.message}`);
  }
  return result.data;
}

/** A locker item with its cover art resolved to a URL, like every catalog read. */
function normalizeUpload(upload: UserUploadAsTrack): UserUploadAsTrack {
  return normalizeTrackImages(upload);
}

/**
 * The audio file as each platform hands it over.
 *
 * `file` is present on web, where `expo-document-picker` returns a real DOM
 * `File`; native has only the `uri`, which React Native's `FormData` accepts as
 * a `{ uri, name, type }` descriptor.
 */
export interface UploadAudioFile {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
  /** Present on web when the picker returned a DOM File. */
  file?: File;
}

/** Everything sent alongside the file. Every metadata field is an override. */
export interface UploadRequest {
  destination: UploadDestination;
  title?: string;
  artistName?: string;
  albumName?: string;
  /** Cover art as an uploaded image id (MongoDB ObjectId), never a URL or blob. */
  coverArt?: string;
  /** Required by the backend when `destination` is `public`. */
  attestation?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Recover a `blocked` outcome from a rejected request.
 *
 * The two body positions are the two error shapes this app produces: `@oxyhq/core`
 * HttpService puts the parsed body at `data`, bare axios nests it under
 * `response.data`. Anything that does not parse as an outcome is not a refusal —
 * it is a transport or server failure and must keep travelling as one.
 */
function blockedOutcomeFromError(error: unknown): UploadOutcome | null {
  if (!isRecord(error)) {
    return null;
  }

  const candidates: unknown[] = [error.data];
  if (isRecord(error.response)) {
    candidates.push(error.response.data);
  }

  for (const candidate of candidates) {
    const parsed = uploadOutcomeSchema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }

  return null;
}

/** Append the audio file under the field name multer expects (`audioFile`). */
async function appendAudioFile(formData: FormData, audioFile: UploadAudioFile): Promise<void> {
  if (Platform.OS === 'web') {
    // Web: prefer the picked File; otherwise fetch the blob the uri points at.
    const blob = audioFile.file ?? (await (await fetch(audioFile.uri)).blob());
    formData.append('audioFile', blob, audioFile.name);
    return;
  }

  // React Native FormData accepts a { uri, name, type } descriptor, which is not
  // part of the DOM FormData.append signature, so it goes through a typed Blob view.
  const rnFilePart = {
    uri: audioFile.uri,
    name: audioFile.name,
    type: audioFile.mimeType,
  } as unknown as Blob;
  formData.append('audioFile', rnFilePart, audioFile.name);
}

/** Multipart carries strings only; an absent override is simply not appended. */
function appendOverrides(formData: FormData, request: Omit<UploadRequest, 'destination'>): void {
  if (request.title?.trim()) formData.append('title', request.title.trim());
  if (request.artistName?.trim()) formData.append('artistName', request.artistName.trim());
  if (request.albumName?.trim()) formData.append('albumName', request.albumName.trim());
  if (request.coverArt) formData.append('coverArt', request.coverArt);
  if (request.attestation) formData.append('attestation', request.attestation);
}

export const uploadsService = {
  /**
   * Upload one file and learn what happened to it.
   *
   * Resolves with the outcome for every routed result INCLUDING `blocked` — a
   * refusal is information the uploader is owed, not an exception. Only a
   * genuine failure (network, 5xx, a body that is not an outcome) rejects.
   */
  async createUpload(audioFile: UploadAudioFile, request: UploadRequest): Promise<UploadOutcome> {
    const formData = new FormData();
    await appendAudioFile(formData, audioFile);
    formData.append('destination', request.destination);
    appendOverrides(formData, request);

    try {
      const response = await api.post<unknown>('/uploads', formData, {
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return parse(uploadOutcomeSchema, response.data, 'upload');
    } catch (error) {
      const blocked = blockedOutcomeFromError(error);
      if (blocked) {
        return blocked;
      }
      throw error;
    }
  },

  /**
   * Contribute a file already in the locker to the public catalogue.
   *
   * Same outcome contract as {@link createUpload}, and for the same reason: the
   * contribution matrix can refuse this too, and the uploader needs to know why.
   */
  async promoteUpload(uploadId: string, request: Omit<UploadRequest, 'destination'>): Promise<UploadOutcome> {
    const formData = new FormData();
    appendOverrides(formData, request);

    try {
      const response = await api.post<unknown>(`/uploads/${uploadId}/promote`, formData, {
        timeout: UPLOAD_TIMEOUT_MS,
      });
      return parse(uploadOutcomeSchema, response.data, 'upload promotion');
    } catch (error) {
      const blocked = blockedOutcomeFromError(error);
      if (blocked) {
        return blocked;
      }
      throw error;
    }
  },

  /** The caller's own locker, newest first. There is no id parameter by design. */
  async listUploads(params?: { limit?: number; offset?: number }): Promise<UploadListResponse> {
    const response = await api.get<unknown>('/uploads', params);
    const parsed = parse(uploadListResponseSchema, response.data, 'uploads');
    return { ...parsed, uploads: parsed.uploads.map(normalizeUpload) };
  },

  /**
   * The locker's releases, grouped server-side.
   *
   * Owner-scoped from the session with no id parameter, and it runs on the
   * `{ownerOxyUserId, albumKey, discNumber, trackNumber}` index — so this is the
   * album LIST at any size, rather than something derived from a page of tracks.
   * Files with no album tag are absent by construction: `albumKey` is undefined
   * for them, and grouping on a key built from nothing would collect every
   * untagged upload into one phantom release.
   */
  async listUploadAlbums(): Promise<UploadAlbumsResponse> {
    const response = await api.get<unknown>('/uploads/albums');
    const parsed = parse(uploadAlbumsResponseSchema, response.data, 'upload albums');
    return {
      ...parsed,
      albums: parsed.albums.map((album) => ({
        ...album,
        coverArt: resolveCatalogImageUrl(album.coverArt),
      })),
    };
  },

  async getUpload(uploadId: string): Promise<UserUploadAsTrack> {
    const response = await api.get<unknown>(`/uploads/${uploadId}`);
    return normalizeUpload(parse(userUploadAsTrackSchema, response.data, 'upload'));
  },

  /** Correct the metadata the extractor read out of the file. */
  async updateUpload(uploadId: string, patch: UpdateUserUploadRequest): Promise<UserUploadAsTrack> {
    const response = await api.patch<unknown>(`/uploads/${uploadId}`, patch);
    return normalizeUpload(parse(userUploadAsTrackSchema, response.data, 'upload'));
  },

  async deleteUpload(uploadId: string): Promise<void> {
    await api.delete(`/uploads/${uploadId}`);
  },
};
