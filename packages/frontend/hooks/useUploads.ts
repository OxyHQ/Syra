import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  UpdateUserUploadRequest,
  UploadOutcome,
  UserUploadAsTrack,
} from '@syra/shared-types';
import {
  uploadsService,
  type UploadAlbumsResponse,
  type UploadAudioFile,
  type UploadListResponse,
  type UploadRequest,
} from '@/services/uploadsService';
import { useAuthGate, type CatalogIdentity } from '@/hooks/useAuthGate';

/**
 * React Query layer for the listener's own uploads.
 *
 * Every uploads endpoint is private API, so each query is gated on a RESOLVED
 * session (`canUsePrivateApi`) and keyed by identity. The identity suffix is not
 * decoration: without it a guest cold-boot response — an empty locker, or a 401 —
 * would populate the cache the authenticated read then hits, and the listener
 * would be told their locker is empty because of when they loaded the page.
 */

const UPLOADS_QUERY_ROOT = 'uploads';

/** While ingest is transcoding, ask again this often. */
const PROCESSING_POLL_INTERVAL_MS = 3000;

export function uploadsListQueryKey(identity: CatalogIdentity) {
  return [UPLOADS_QUERY_ROOT, 'list', identity] as const;
}

export function uploadAlbumsQueryKey(identity: CatalogIdentity) {
  return [UPLOADS_QUERY_ROOT, 'albums', identity] as const;
}

/**
 * The locker's releases, grouped by the server.
 *
 * A separate query from {@link useUploads} rather than something derived from
 * it: the grouping runs on an index server-side, so it stays correct past the
 * page size of the track list and never depends on how many tracks happen to be
 * loaded.
 *
 * Deliberately does NOT poll, unlike the track list. The aggregation does not
 * filter on `status`, so a file belongs to its release from the moment it is
 * created and ingest finishing changes nothing here. What DOES change the list —
 * an upload, a delete, a promotion — already invalidates it through the shared
 * `['uploads']` prefix.
 */
export function useUploadAlbums() {
  const gate = useAuthGate();

  const query = useQuery<UploadAlbumsResponse>({
    queryKey: uploadAlbumsQueryKey(gate.catalogIdentity),
    queryFn: () => uploadsService.listUploadAlbums(),
    enabled: gate.canUsePrivateApi,
  });

  return {
    albums: query.data?.albums ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * The caller's locker.
 *
 * Polls itself while anything in it is still `processing` and stops the moment
 * everything has reached `ready` or `failed` — the same terminal-status rule the
 * studio's upload screen polls on, expressed as a property of the data rather
 * than a loop that has to be started and torn down.
 */
export function useUploads() {
  const gate = useAuthGate();

  const query = useQuery<UploadListResponse>({
    queryKey: uploadsListQueryKey(gate.catalogIdentity),
    queryFn: () => uploadsService.listUploads({ limit: 200 }),
    enabled: gate.canUsePrivateApi,
    refetchInterval: (query) =>
      query.state.data?.uploads.some((upload) => upload.status === 'processing')
        ? PROCESSING_POLL_INTERVAL_MS
        : false,
  });

  return {
    uploads: query.data?.uploads ?? [],
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Invalidate every identity's locker list — the mutation changed what is in it. */
function invalidateUploads(queryClient: ReturnType<typeof useQueryClient>): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: [UPLOADS_QUERY_ROOT] });
}

export interface CreateUploadVariables {
  audioFile: UploadAudioFile;
  request: UploadRequest;
}

/**
 * Upload one file.
 *
 * Resolves with a `blocked` outcome rather than rejecting, because a refusal is
 * a result the screen renders — with the reason and the evidence — not an error
 * banner. `onError` therefore only ever fires for a genuine failure.
 */
export function useCreateUpload() {
  const queryClient = useQueryClient();

  return useMutation<UploadOutcome, Error, CreateUploadVariables>({
    mutationFn: ({ audioFile, request }) => uploadsService.createUpload(audioFile, request),
    onSuccess: (outcome) => {
      // `matched` stored nothing and `blocked` published nothing, so neither
      // changes the locker. The other three do.
      if (outcome.outcome === 'stored' || outcome.outcome === 'published' || outcome.outcome === 'duplicate') {
        void invalidateUploads(queryClient);
      }
    },
  });
}

export interface PromoteUploadVariables {
  uploadId: string;
  request: Omit<UploadRequest, 'destination'>;
}

/** Contribute a file already in the locker to the public catalogue. */
export function usePromoteUpload() {
  const queryClient = useQueryClient();

  return useMutation<UploadOutcome, Error, PromoteUploadVariables>({
    mutationFn: ({ uploadId, request }) => uploadsService.promoteUpload(uploadId, request),
    onSuccess: (outcome) => {
      if (outcome.outcome === 'published') {
        void invalidateUploads(queryClient);
      }
    },
  });
}

export interface UpdateUploadVariables {
  uploadId: string;
  patch: UpdateUserUploadRequest;
}

/** Correct the metadata the extractor read out of the file. */
export function useUpdateUpload() {
  const queryClient = useQueryClient();

  return useMutation<UserUploadAsTrack, Error, UpdateUploadVariables>({
    mutationFn: ({ uploadId, patch }) => uploadsService.updateUpload(uploadId, patch),
    onSuccess: () => {
      void invalidateUploads(queryClient);
    },
  });
}

export function useDeleteUpload() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: (uploadId) => uploadsService.deleteUpload(uploadId),
    onSuccess: () => {
      void invalidateUploads(queryClient);
    },
  });
}
