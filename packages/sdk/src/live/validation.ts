import {
  array,
  boolean,
  formatPath,
  looseObject,
  nullish,
  number,
  object,
  oneOf,
  optional,
  preprocess,
  refine,
  string,
  type ValidationIssue,
  type Validator,
  withDefault,
} from '../validate';

/**
 * The live-rooms wire types and the runtime checks the rooms service runs on
 * them. Every object here KEEPS keys it does not name (the backend adds fields
 * faster than the SDK ships), fills the documented defaults, and drops a whole
 * row it cannot read rather than handing the UI half of one.
 *
 * These checks used to be Zod schemas; they are plain TypeScript now so that an
 * app rendering a room does not ship Zod for it. The Zod versions remain, for
 * server consumers, at `@syra.fm/sdk/schemas` (`./schema`), and
 * `validation.parity.test.ts` holds the two to the same answers.
 */

/** Keys the backend may add that the SDK does not name are kept as sent. */
type Open = { [key: string]: unknown };

export const ROOM_OWNER_TYPES = ['profile', 'house', 'agora'] as const;
export const ROOM_TYPES = ['talk', 'stage', 'broadcast'] as const;
export const BROADCAST_KINDS = ['user', 'agora'] as const;
export const ROOM_STATUSES = ['scheduled', 'live', 'ended'] as const;
export const SPEAKER_PERMISSIONS = ['everyone', 'followers', 'invited'] as const;
export const PARTICIPANT_ROLES = ['host', 'speaker', 'listener'] as const;
export const HOUSE_ROLES = ['owner', 'admin', 'host', 'member'] as const;
export const HOUSE_DISCOVERY = ['listed', 'unlisted', 'hidden'] as const;
export const HOUSE_ROOM_ACCESS = ['anyone', 'members'] as const;
export const HOUSE_JOIN = ['anyone', 'invite'] as const;
export const RECURRENCE_TYPES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export const RECORDING_STATUSES = [
  'recording',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;
export const RECORDING_ACCESS = ['public', 'participants'] as const;

export type RoomType = (typeof ROOM_TYPES)[number];
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export type SpeakerPermission = (typeof SPEAKER_PERMISSIONS)[number];

// --- Types ---

/**
 * One podcast episode queued behind the current stream. `episodeId` is the
 * opaque Syra episode handle; `syraPodcastId` (when present) identifies its show.
 * The playable audio URL is never carried here — it is resolved server-side at
 * play-time.
 */
export interface PodcastQueueItem extends Open {
  syraPodcastId?: string;
  episodeId: string;
}

export interface Room extends Open {
  id: string;
  title: string;
  description?: string | null;

  // Ownership
  ownerType: (typeof ROOM_OWNER_TYPES)[number];
  host: string;
  houseId?: string | null;
  createdByAdmin?: string | null;

  // Classification
  type: RoomType;
  broadcastKind?: (typeof BROADCAST_KINDS)[number] | null;

  // Lifecycle
  status: RoomStatus;
  scheduledStart?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;

  // Participation
  speakerPermission?: SpeakerPermission | null;
  participants: string[];
  speakers: string[];
  maxParticipants: number;

  // Content
  topic?: string | null;
  tags?: string[];
  archived: boolean;
  seriesId?: string | null;

  // Stats
  stats?: { peakListeners: number; totalJoined: number };

  // Streaming
  activeIngressId?: string | null;
  activeStreamUrl?: string | null;
  streamTitle?: string | null;
  streamImage?: string | null;
  streamDescription?: string | null;
  rtmpUrl?: string | null;
  rtmpStreamKey?: string | null;
  /**
   * Stream progress + podcast lifecycle (shared contract with the backend).
   * `streamStartedAt` is an ISO timestamp; `streamDurationSec` is the current
   * stream's total length in seconds when known (e.g. a podcast episode);
   * `podcastQueue` holds the episodes queued behind the current one.
   */
  streamStartedAt?: string | null;
  streamDurationSec?: number | null;
  podcastQueue?: PodcastQueueItem[] | null;

  // Recording
  recordingEnabled: boolean;
  recordingEgressId?: string | null;

  createdAt: string;
}

export interface RoomParticipant extends Open {
  userId: string;
  role: (typeof PARTICIPANT_ROLES)[number];
  isMuted: boolean;
  joinedAt: string;
}

export interface HouseMember extends Open {
  userId: string;
  role: (typeof HOUSE_ROLES)[number];
  joinedAt: string;
}

/**
 * House visibility as three orthogonal axes — mirrors the backend `House`
 * model. `discovery` (who can find it), `rooms` (who can see/enter its rooms),
 * `join` (how one becomes a member). See the backend model for the full
 * contract.
 */
export interface HouseVisibility extends Open {
  discovery: (typeof HOUSE_DISCOVERY)[number];
  rooms: (typeof HOUSE_ROOM_ACCESS)[number];
  join: (typeof HOUSE_JOIN)[number];
}

export interface House extends Open {
  id: string;
  name: string;
  description?: string;
  avatar?: string | null;
  coverImage?: string | null;
  /**
   * Withheld from non-members of a `rooms: members` house; `memberCount` is sent
   * in its place.
   */
  members: HouseMember[];
  memberCount?: number;
  createdBy: string;
  visibility: HouseVisibility;
  tags?: string[];
  createdAt: string;
}

export interface Recurrence extends Open {
  type: (typeof RECURRENCE_TYPES)[number];
  /** 0–6. */
  dayOfWeek?: number;
  /** 1–31. */
  dayOfMonth?: number;
  /** `HH:MM`. */
  time: string;
  timezone: string;
}

export interface RoomTemplate extends Open {
  titlePattern: string;
  type: RoomType;
  description?: string;
  maxParticipants: number;
  speakerPermission: SpeakerPermission;
  tags?: string[];
}

export interface SeriesEpisode extends Open {
  roomId: string;
  scheduledStart: string;
  episodeNumber: number;
}

export interface Series extends Open {
  id: string;
  title: string;
  description?: string;
  coverImage?: string | null;
  houseId?: string | null;
  createdBy: string;
  recurrence: Recurrence;
  roomTemplate: RoomTemplate;
  episodes: SeriesEpisode[];
  nextEpisodeNumber: number;
  isActive: boolean;
  createdAt: string;
}

export interface Recording extends Open {
  id: string;
  roomId: string;
  roomTitle: string;
  host: string;
  status: (typeof RECORDING_STATUSES)[number];
  egressId: string;
  objectKey: string;
  fileSize?: number | null;
  durationMs?: number | null;
  startedAt: string;
  stoppedAt?: string | null;
  access: (typeof RECORDING_ACCESS)[number];
  participantIds: string[];
  expiresAt: string;
  createdAt: string;
}

export interface StartStreamResponse extends Open {
  ingressId: string;
  url: string;
}

export interface GenerateStreamKeyResponse extends Open {
  rtmpUrl: string;
  streamKey: string;
}

/** Room attachment for posts. */
export interface RoomAttachment extends Open {
  roomId: string;
  title: string;
  status?: RoomStatus;
  type?: RoomType;
  topic?: string;
  host?: string;
}

// --- Checks ---

/**
 * Accept a payload whose identity arrives as `_id` and present it as `id`.
 *
 * `id` is REQUIRED on the four types below, which is correct against the current
 * backend — `_id` is not part of the wire contract. But the frontend deploys on its own path (`deploy-frontends.yml`, on `packages/frontend`
 * and `packages/shared-types`) while the backend deploy is gated, so a merge to
 * `main` can ship the client half ALONE. It did once: `GET /rooms` answered `_id`,
 * every room failed the room check, and `validateRooms` DROPS what it cannot
 * read — so the Live screen went empty in production with only a `console.warn`
 * to say so.
 *
 * Normalising here rather than teaching call sites to read `room.id ?? room._id`
 * is the architecture this repo already states: parse once at the API boundary and
 * return typed data. One place, no UI knows, and it is correct against an older
 * backend too — so no coordinated client flip is needed.
 *
 * It can be deleted once no deployed Syra backend serves `_id`. Nothing breaks if
 * it outlives that: a payload carrying only `id` passes through untouched.
 */
export function underscoreIdAsId(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const doc = value as Record<string, unknown>;
  if (typeof doc.id === 'string' || typeof doc._id !== 'string') return value;
  return { ...doc, id: doc._id };
}

const strings = array(string);

const podcastQueueItem = looseObject<PodcastQueueItem>({
  syraPodcastId: optional(string),
  episodeId: string,
});

export const roomCheck = preprocess(
  underscoreIdAsId,
  looseObject<Room>({
    id: string,
    title: string,
    description: nullish(string),
    ownerType: withDefault(oneOf(ROOM_OWNER_TYPES), () => 'profile'),
    host: string,
    houseId: nullish(string),
    createdByAdmin: nullish(string),
    type: withDefault(oneOf(ROOM_TYPES), () => 'talk'),
    broadcastKind: nullish(oneOf(BROADCAST_KINDS)),
    status: oneOf(ROOM_STATUSES),
    scheduledStart: nullish(string),
    startedAt: nullish(string),
    endedAt: nullish(string),
    speakerPermission: nullish(oneOf(SPEAKER_PERMISSIONS)),
    participants: withDefault(strings, () => []),
    speakers: withDefault(strings, () => []),
    maxParticipants: withDefault(number, () => 100),
    topic: nullish(string),
    tags: optional(strings),
    archived: withDefault(boolean, () => false),
    seriesId: nullish(string),
    // The one nested object here that drops unknown keys, as its schema always has.
    stats: optional(
      object<{ peakListeners: number; totalJoined: number }>({
        peakListeners: number,
        totalJoined: number,
      }),
    ),
    activeIngressId: nullish(string),
    activeStreamUrl: nullish(string),
    streamTitle: nullish(string),
    streamImage: nullish(string),
    streamDescription: nullish(string),
    rtmpUrl: nullish(string),
    rtmpStreamKey: nullish(string),
    streamStartedAt: nullish(string),
    streamDurationSec: nullish(number),
    podcastQueue: nullish(array(podcastQueueItem)),
    recordingEnabled: withDefault(boolean, () => true),
    recordingEgressId: nullish(string),
    createdAt: string,
  }),
);

const houseMember = looseObject<HouseMember>({
  userId: string,
  role: oneOf(HOUSE_ROLES),
  joinedAt: string,
});

const houseVisibility = looseObject<HouseVisibility>({
  discovery: withDefault(oneOf(HOUSE_DISCOVERY), () => 'listed'),
  rooms: withDefault(oneOf(HOUSE_ROOM_ACCESS), () => 'anyone'),
  join: withDefault(oneOf(HOUSE_JOIN), () => 'invite'),
});

export const houseCheck = preprocess(
  underscoreIdAsId,
  looseObject<House>({
    id: string,
    name: string,
    description: optional(string),
    avatar: nullish(string),
    coverImage: nullish(string),
    members: withDefault(array(houseMember), () => []),
    memberCount: optional(number),
    createdBy: string,
    visibility: withDefault(houseVisibility, () => ({
      discovery: 'listed',
      rooms: 'anyone',
      join: 'invite',
    })),
    tags: optional(strings),
    createdAt: string,
  }),
);

const numberBetween = (min: number, max: number): Validator<number> =>
  refine(number, (n) => n >= min && n <= max, `expected a number from ${min} to ${max}`);

const recurrence = looseObject<Recurrence>({
  type: oneOf(RECURRENCE_TYPES),
  dayOfWeek: optional(numberBetween(0, 6)),
  dayOfMonth: optional(numberBetween(1, 31)),
  time: refine(string, (time) => /^\d{2}:\d{2}$/.test(time), 'expected HH:MM'),
  timezone: withDefault(string, () => 'UTC'),
});

const roomTemplate = looseObject<RoomTemplate>({
  titlePattern: string,
  type: withDefault(oneOf(ROOM_TYPES), () => 'talk'),
  description: optional(string),
  maxParticipants: withDefault(number, () => 100),
  speakerPermission: withDefault(oneOf(SPEAKER_PERMISSIONS), () => 'invited'),
  tags: optional(strings),
});

const seriesEpisode = looseObject<SeriesEpisode>({
  roomId: string,
  scheduledStart: string,
  episodeNumber: number,
});

export const seriesCheck = preprocess(
  underscoreIdAsId,
  looseObject<Series>({
    id: string,
    title: string,
    description: optional(string),
    coverImage: nullish(string),
    houseId: nullish(string),
    createdBy: string,
    recurrence,
    roomTemplate,
    episodes: withDefault(array(seriesEpisode), () => []),
    nextEpisodeNumber: withDefault(number, () => 1),
    isActive: withDefault(boolean, () => true),
    createdAt: string,
  }),
);

export const recordingCheck = preprocess(
  underscoreIdAsId,
  looseObject<Recording>({
    id: string,
    roomId: string,
    roomTitle: string,
    host: string,
    status: oneOf(RECORDING_STATUSES),
    egressId: string,
    objectKey: string,
    fileSize: nullish(number),
    durationMs: nullish(number),
    startedAt: string,
    stoppedAt: nullish(string),
    access: withDefault(oneOf(RECORDING_ACCESS), () => 'public'),
    participantIds: withDefault(strings, () => []),
    expiresAt: string,
    createdAt: string,
  }),
);

export const startStreamResponseCheck = looseObject<StartStreamResponse>({
  ingressId: string,
  url: string,
});

export const generateStreamKeyResponseCheck = looseObject<GenerateStreamKeyResponse>({
  rtmpUrl: string,
  streamKey: string,
});

// --- Validators ---

function warnIssue(label: string, issue: ValidationIssue): void {
  console.warn(label, `${formatPath(issue.path)}: ${issue.message}`);
}

/** The checked value, or `null` after a `console.warn` naming the failing field. */
export function validateResponse<T>(check: Validator<T>, data: unknown, label: string): T | null {
  const checked = check(data, []);
  if (checked.ok) return checked.value;
  warnIssue(label, checked.issue);
  return null;
}

export function validateRoom(data: unknown): Room | null {
  return validateResponse(roomCheck, data, '[live] Invalid Room:');
}

export function validateRooms(items: unknown[]): Room[] {
  if (!Array.isArray(items)) return [];
  const valid: Room[] = [];
  for (const item of items) {
    const checked = roomCheck(item, []);
    if (checked.ok) valid.push(checked.value);
    else warnIssue('[live] Dropping invalid room:', checked.issue);
  }
  return valid;
}

export function validateHouse(data: unknown): House | null {
  return validateResponse(houseCheck, data, '[live] Invalid House:');
}

export function validateRecording(data: unknown): Recording | null {
  return validateResponse(recordingCheck, data, '[live] Invalid Recording:');
}

export function validateRecordings(items: unknown[]): Recording[] {
  if (!Array.isArray(items)) return [];
  const valid: Recording[] = [];
  for (const item of items) {
    const checked = recordingCheck(item, []);
    if (checked.ok) valid.push(checked.value);
  }
  return valid;
}

export function validateSeries(data: unknown): Series | null {
  return validateResponse(seriesCheck, data, '[live] Invalid Series:');
}
