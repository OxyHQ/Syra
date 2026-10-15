import { z } from 'zod';
import type { Same } from '../schema';
import {
  underscoreIdAsId,
  type GenerateStreamKeyResponse,
  type House,
  type HouseMember,
  type HouseVisibility,
  type PodcastQueueItem,
  type Recording,
  type Recurrence,
  type Room,
  type RoomAttachment,
  type RoomParticipant,
  type RoomTemplate,
  type Series,
  type SeriesEpisode,
  type StartStreamResponse,
} from './validation';

/**
 * The live-rooms wire types as Zod schemas, for SERVER-side consumers. Served
 * only from `@syra.fm/sdk/schemas`: the rooms engine itself checks the same
 * shapes with `./validation`, so an app rendering a room does not ship Zod.
 * `validation.parity.test.ts` holds the two to the same answers, and the
 * `Same<…>` lines below fail the build when a schema and its type disagree. The
 * field docs live on the types in `./validation`.
 */

/** See `underscoreIdAsId` in `./validation` for why `_id` is accepted. */
function withUnderscoreIdFallback<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(underscoreIdAsId, schema);
}

// --- Podcast queue ---

/**
 * One podcast episode queued behind the current stream. `episodeId` is the
 * opaque Syra episode handle; `syraPodcastId` (when present) identifies its show.
 * The playable audio URL is never carried here — it is resolved server-side at
 * play-time.
 */
export const ZPodcastQueueItem = z
  .object({
    syraPodcastId: z.string().optional(),
    episodeId: z.string(),
  })
  .passthrough();

// --- Room (replaces Space) ---

export const ZRoom = withUnderscoreIdFallback(
  z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullish(),

      // Ownership
      ownerType: z.enum(['profile', 'house', 'agora']).default('profile'),
      host: z.string(),
      houseId: z.string().optional().nullable(),
      createdByAdmin: z.string().optional().nullable(),

      // Classification
      type: z.enum(['talk', 'stage', 'broadcast']).default('talk'),
      broadcastKind: z.enum(['user', 'agora']).optional().nullable(),

      // Lifecycle
      status: z.enum(['scheduled', 'live', 'ended']),
      scheduledStart: z.string().nullish(),
      startedAt: z.string().nullish(),
      endedAt: z.string().nullish(),

      // Participation
      speakerPermission: z.enum(['everyone', 'followers', 'invited']).nullish(),
      participants: z.array(z.string()).default([]),
      speakers: z.array(z.string()).default([]),
      maxParticipants: z.number().default(100),

      // Content
      topic: z.string().nullish(),
      tags: z.array(z.string()).optional(),
      archived: z.boolean().optional().default(false),
      seriesId: z.string().nullish(),

      // Stats
      stats: z
        .object({
          peakListeners: z.number(),
          totalJoined: z.number(),
        })
        .optional(),

      // Streaming
      activeIngressId: z.string().nullish(),
      activeStreamUrl: z.string().nullish(),
      streamTitle: z.string().nullish(),
      streamImage: z.string().nullish(),
      streamDescription: z.string().nullish(),
      rtmpUrl: z.string().nullish(),
      rtmpStreamKey: z.string().nullish(),
      // Stream progress + podcast lifecycle (shared contract with the backend).
      // `streamStartedAt` is an ISO timestamp; `streamDurationSec` is the current
      // stream's total length in seconds when known (e.g. a podcast episode);
      // `podcastQueue` holds the episodes queued behind the current one.
      streamStartedAt: z.string().nullish(),
      streamDurationSec: z.number().nullish(),
      podcastQueue: z.array(ZPodcastQueueItem).nullish(),

      // Recording
      recordingEnabled: z.boolean().optional().default(true),
      recordingEgressId: z.string().nullish(),

      createdAt: z.string(),
    })
    .passthrough(),
);

// --- Room Participant ---

export const ZRoomParticipant = z
  .object({
    userId: z.string(),
    role: z.enum(['host', 'speaker', 'listener']),
    isMuted: z.boolean(),
    joinedAt: z.string(),
  })
  .passthrough();

// --- House ---

export const ZHouseMember = z
  .object({
    userId: z.string(),
    role: z.enum(['owner', 'admin', 'host', 'member']),
    joinedAt: z.string(),
  })
  .passthrough();

/**
 * House visibility as three orthogonal axes — mirrors the backend `House`
 * model. `discovery` (who can find it), `rooms` (who can see/enter its rooms),
 * `join` (how one becomes a member). See the backend model for the full
 * contract.
 */
export const ZHouseVisibility = z
  .object({
    discovery: z.enum(['listed', 'unlisted', 'hidden']).default('listed'),
    rooms: z.enum(['anyone', 'members']).default('anyone'),
    join: z.enum(['anyone', 'invite']).default('invite'),
  })
  .passthrough();

export const ZHouse = withUnderscoreIdFallback(
  z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      avatar: z.string().optional().nullable(),
      coverImage: z.string().optional().nullable(),
      // Withheld from non-members of a `rooms: members` house; `memberCount` is sent
      // in its place. Both survive `.passthrough()`.
      members: z.array(ZHouseMember).default([]),
      memberCount: z.number().optional(),
      createdBy: z.string(),
      visibility: ZHouseVisibility.default({
        discovery: 'listed',
        rooms: 'anyone',
        join: 'invite',
      }),
      tags: z.array(z.string()).optional(),
      createdAt: z.string(),
    })
    .passthrough(),
);

// --- Series ---

export const ZRecurrence = z
  .object({
    type: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
    dayOfWeek: z.number().min(0).max(6).optional(),
    dayOfMonth: z.number().min(1).max(31).optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.string().default('UTC'),
  })
  .passthrough();

export const ZRoomTemplate = z
  .object({
    titlePattern: z.string(),
    type: z.enum(['talk', 'stage', 'broadcast']).default('talk'),
    description: z.string().optional(),
    maxParticipants: z.number().default(100),
    speakerPermission: z.enum(['everyone', 'followers', 'invited']).default('invited'),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export const ZSeriesEpisode = z
  .object({
    roomId: z.string(),
    scheduledStart: z.string(),
    episodeNumber: z.number(),
  })
  .passthrough();

export const ZSeries = withUnderscoreIdFallback(
  z
    .object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      coverImage: z.string().optional().nullable(),
      houseId: z.string().optional().nullable(),
      createdBy: z.string(),
      recurrence: ZRecurrence,
      roomTemplate: ZRoomTemplate,
      episodes: z.array(ZSeriesEpisode).default([]),
      nextEpisodeNumber: z.number().default(1),
      isActive: z.boolean().default(true),
      createdAt: z.string(),
    })
    .passthrough(),
);

// --- Recording ---

export const ZRecording = withUnderscoreIdFallback(
  z
    .object({
      id: z.string(),
      roomId: z.string(),
      roomTitle: z.string(),
      host: z.string(),
      status: z.enum(['recording', 'processing', 'ready', 'failed', 'deleted']),
      egressId: z.string(),
      objectKey: z.string(),
      fileSize: z.number().nullish(),
      durationMs: z.number().nullish(),
      startedAt: z.string(),
      stoppedAt: z.string().nullish(),
      access: z.enum(['public', 'participants']).default('public'),
      participantIds: z.array(z.string()).default([]),
      expiresAt: z.string(),
      createdAt: z.string(),
    })
    .passthrough(),
);

// --- Stream responses ---

export const ZStartStreamResponse = z
  .object({
    ingressId: z.string(),
    url: z.string(),
  })
  .passthrough();

export const ZGenerateStreamKeyResponse = z
  .object({
    rtmpUrl: z.string(),
    streamKey: z.string(),
  })
  .passthrough();

export const ZStreamInfo = z
  .object({
    title: z.string().optional(),
    image: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

// --- Room attachment for posts ---

export const ZRoomAttachment = z
  .object({
    roomId: z.string(),
    title: z.string(),
    status: z.enum(['scheduled', 'live', 'ended']).optional(),
    type: z.enum(['talk', 'stage', 'broadcast']).optional(),
    topic: z.string().optional(),
    host: z.string().optional(),
  })
  .passthrough();

type Assert<T extends true> = T;

export type LiveSchemaMatchesType = [
  Assert<Same<z.output<typeof ZPodcastQueueItem>, PodcastQueueItem>>,
  Assert<Same<z.output<typeof ZRoom>, Room>>,
  Assert<Same<z.output<typeof ZRoomParticipant>, RoomParticipant>>,
  Assert<Same<z.output<typeof ZHouseMember>, HouseMember>>,
  Assert<Same<z.output<typeof ZHouseVisibility>, HouseVisibility>>,
  Assert<Same<z.output<typeof ZHouse>, House>>,
  Assert<Same<z.output<typeof ZRecurrence>, Recurrence>>,
  Assert<Same<z.output<typeof ZRoomTemplate>, RoomTemplate>>,
  Assert<Same<z.output<typeof ZSeriesEpisode>, SeriesEpisode>>,
  Assert<Same<z.output<typeof ZSeries>, Series>>,
  Assert<Same<z.output<typeof ZRecording>, Recording>>,
  Assert<Same<z.output<typeof ZStartStreamResponse>, StartStreamResponse>>,
  Assert<Same<z.output<typeof ZGenerateStreamKeyResponse>, GenerateStreamKeyResponse>>,
  Assert<Same<z.output<typeof ZRoomAttachment>, RoomAttachment>>,
];
