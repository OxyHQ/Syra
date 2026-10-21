import { describe, expect, it } from 'bun:test';
import type { ZodType } from 'zod';
import * as responses from './responses';
import * as schemas from './schema';
import * as live from './live/validation';
import * as liveSchemas from './live/schema';
import type { Validator } from './validate';

/**
 * The client and the live-rooms engine check responses in plain TypeScript; the
 * Zod schemas at `@syra.fm/sdk/schemas` state the same contract for server
 * consumers. Two definitions of one contract drift unless something holds them
 * together — this runs both over the same inputs and requires the same verdict,
 * the same output (defaults filled, unknown keys dropped or kept), and the same
 * first failing field.
 */

function agree(name: string, schema: ZodType, check: Validator<unknown>, inputs: unknown[]) {
  describe(name, () => {
    inputs.forEach((input, index) => {
      it(`input #${index} gets the same answer from both`, () => {
        const zod = schema.safeParse(input);
        const plain = check(input, []);
        expect(plain.ok).toBe(zod.success);
        if (plain.ok && zod.success) expect(plain.value).toStrictEqual(zod.data);
        if (!plain.ok && !zod.success)
          expect<unknown>(plain.issue.path).toEqual(zod.error.issues[0].path);
      });
    });
  });
}

/** Inputs every object check must answer the same way. */
const NOT_OBJECTS = [null, undefined, 'x', 1, true, []];

const variant = { id: 'i', url: '/api/images/i', width: 64, height: 64 };
const sizes = { small: variant, large: { url: '/api/images/l' } };
const track = { id: 't', title: 'Song', artistName: 'A', duration: 180 };
const podcast = { id: 'p', title: 'Show' };
const episode = { id: 'e', podcastId: 'p', title: 'Ep' };

agree('track summary', schemas.trackSummarySchema, responses.trackSummary, [
  track,
  {
    ...track,
    artistId: 'a',
    albumId: 'b',
    albumName: 'c',
    coverArt: 'img',
    coverArtSizes: sizes,
    previewAvailable: true,
  },
  { ...track, isExplicit: false, createdAt: '2026', coverArtSizes: { small: { url: 'u', x: 1 } } },
  { ...track, albumName: null },
  { ...track, albumName: undefined },
  { ...track, duration: '180' },
  { ...track, duration: Number.NaN },
  { ...track, title: undefined },
  { ...track, coverArtSizes: { small: { url: 1 } } },
  { ...track, coverArtSizes: [] },
  { ...track, previewAvailable: 'true' },
  ...NOT_OBJECTS,
]);

agree('podcast summary', schemas.podcastSummarySchema, responses.podcastSummary, [
  podcast,
  {
    ...podcast,
    author: 'a',
    description: 'd',
    image: 'i',
    imageSizes: sizes,
    imageSourceUrl: 'https://x',
    visibility: 'private',
    aiGenerated: false,
  },
  { ...podcast, visibility: 'friends' },
  { ...podcast, visibility: null },
  { ...podcast, ownerId: 'o', episodeCount: 3 },
  { id: 'p' },
  ...NOT_OBJECTS,
]);

agree('podcast subscription', schemas.podcastSubscriptionSchema, responses.podcastSubscription, [
  { podcast },
  { podcast: { ...podcast, extra: 1 }, lastEpisodeAt: '2026-01-01', subscribedAt: 'x' },
  { podcast: { id: 'p' } },
  { lastEpisodeAt: '2026-01-01' },
  ...NOT_OBJECTS,
]);

agree('episode summary', schemas.episodeSummarySchema, responses.episodeSummary, [
  episode,
  {
    ...episode,
    description: 'd',
    enclosureUrl: 'https://x/a.mp3',
    enclosureType: 'audio/mpeg',
    enclosureLength: 10,
    audioSource: { url: '/api/a', format: 'hls', bitrate: 128, duration: 60, codec: 'aac' },
    duration: 60,
    pubDate: '2026',
    season: 1,
    episodeNumber: 2,
    status: 'processing',
    aiGenerated: true,
    image: 'i',
    imageSizes: sizes,
    imageSourceUrl: 'https://x',
  },
  { ...episode, status: 'gone' },
  { ...episode, audioSource: { format: 'hls' } },
  { ...episode, guid: 'g', podcastTitle: 'Show' },
  { id: 'e', title: 'Ep' },
  ...NOT_OBJECTS,
]);

agree('episode draft', schemas.episodeDraftSchema, responses.episodeDraft, [
  { episodeId: 'e', ingestTicket: 't', expiresAt: '2026' },
  { episodeId: 'e', ingestTicket: 't' },
  ...NOT_OBJECTS,
]);

const uploadTarget = {
  uploadId: 'u',
  url: 'https://syra-media.acct.r2.cloudflarestorage.com/incoming/x?X-Amz-Signature=s',
  method: 'PUT',
  headers: { 'Content-Type': 'audio/mpeg' },
  maxBytes: 100,
  expiresAt: '2026',
};

agree('audio upload target', schemas.audioUploadTargetSchema, responses.audioUploadTarget, [
  uploadTarget,
  { ...uploadTarget, headers: {} },
  { ...uploadTarget, extra: true },
  { ...uploadTarget, method: 'POST' },
  { ...uploadTarget, headers: { 'Content-Type': 1 } },
  { ...uploadTarget, headers: [] },
  { ...uploadTarget, headers: null },
  { ...uploadTarget, maxBytes: '100' },
  { ...uploadTarget, url: undefined },
  ...NOT_OBJECTS,
]);

agree('podcast deleted', schemas.podcastDeletedSchema, responses.podcastDeleted, [
  { id: 'p', episodesDeleted: 0, objectsDeleted: 0 },
  { id: 'p', episodesDeleted: 1, objectsDeleted: '2' },
  ...NOT_OBJECTS,
]);

agree('episode deleted', schemas.episodeDeletedSchema, responses.episodeDeleted, [
  { id: 'e', podcastId: 'p', objectsDeleted: 3, extra: true },
  { id: 'e', objectsDeleted: 3 },
  ...NOT_OBJECTS,
]);

agree('episode stream', schemas.episodeStreamSchema, responses.episodeStream, [
  { url: 'https://x/m3u8', type: 'hls' },
  { url: 'https://x/m3u8', type: 'hls', expiresAt: '2026', token: 'secret' },
  {
    url: 'https://oxy/master.m3u8',
    type: 'hls',
    previewUrl: 'https://oxy/preview.m4a',
    waveformUrl: 'https://oxy/waveform.json',
  },
  { url: 'https://x/m3u8', type: 'hls', waveformUrl: 1 },
  { url: 'https://x/m3u8' },
  ...NOT_OBJECTS,
]);

agree('uploaded image', schemas.uploadedImageSchema, responses.uploadedImage, [
  { id: 'i' },
  { id: 'i', primaryColor: '#000', secondaryColor: '#fff', variants: [] },
  { id: 1 },
  ...NOT_OBJECTS,
]);

// ── Live rooms ────────────────────────────────────────────────────────────────

const room = {
  id: 'r',
  title: 'Room',
  host: 'h',
  status: 'live',
  createdAt: '2026',
};

agree('room', liveSchemas.ZRoom, live.roomCheck, [
  room,
  { ...room, id: undefined, _id: 'legacy' },
  { ...room, id: 'real', _id: 'legacy' },
  { ...room, id: undefined },
  { ...room, description: null, topic: null, houseId: null, broadcastKind: null },
  {
    ...room,
    ownerType: 'house',
    type: 'broadcast',
    broadcastKind: 'agora',
    participants: ['a'],
    speakers: ['b'],
    maxParticipants: 5,
    tags: ['t'],
    archived: true,
    stats: { peakListeners: 1, totalJoined: 2, extra: 3 },
    podcastQueue: [{ episodeId: 'e', syraPodcastId: 'p', title: 'kept' }],
    recordingEnabled: false,
    streamDurationSec: 60,
    unknownField: { nested: true },
  },
  { ...room, podcastQueue: null },
  { ...room, podcastQueue: [{ syraPodcastId: 'p' }] },
  { ...room, status: 'paused' },
  { ...room, type: null },
  { ...room, archived: null },
  { ...room, participants: [1] },
  { ...room, stats: { peakListeners: 1 } },
  ...NOT_OBJECTS,
]);

const house = { id: 'h', name: 'House', createdBy: 'u', createdAt: '2026' };

agree('house', liveSchemas.ZHouse, live.houseCheck, [
  house,
  { ...house, id: undefined, _id: 'legacy' },
  {
    ...house,
    members: [{ userId: 'u', role: 'owner', joinedAt: '2026', nickname: 'kept' }],
    memberCount: 1,
    visibility: { discovery: 'hidden', extra: 1 },
    avatar: null,
    tags: ['x'],
    theme: 'kept',
  },
  { ...house, visibility: { discovery: 'secret' } },
  { ...house, members: [{ userId: 'u', role: 'guest', joinedAt: '2026' }] },
  { ...house, description: null },
  ...NOT_OBJECTS,
]);

const series = {
  id: 's',
  title: 'Series',
  createdBy: 'u',
  recurrence: { type: 'weekly', time: '18:30' },
  roomTemplate: { titlePattern: 'Ep {n}' },
  createdAt: '2026',
};

agree('series', liveSchemas.ZSeries, live.seriesCheck, [
  series,
  { ...series, id: undefined, _id: 'legacy' },
  {
    ...series,
    recurrence: { type: 'monthly', dayOfMonth: 31, time: '00:00', timezone: 'Europe/Madrid' },
    roomTemplate: {
      titlePattern: 'x',
      type: 'stage',
      maxParticipants: 10,
      speakerPermission: 'everyone',
      tags: ['a'],
      extra: 1,
    },
    episodes: [{ roomId: 'r', scheduledStart: '2026', episodeNumber: 1, kept: true }],
    nextEpisodeNumber: 2,
    isActive: false,
  },
  { ...series, recurrence: { type: 'weekly', time: '6pm' } },
  { ...series, recurrence: { type: 'weekly', time: '18:30', dayOfWeek: 7 } },
  { ...series, recurrence: { type: 'weekly', time: '18:30', dayOfWeek: -1 } },
  { ...series, recurrence: { type: 'monthly', time: '18:30', dayOfMonth: 0 } },
  { ...series, recurrence: { type: 'yearly', time: '18:30' } },
  { ...series, roomTemplate: {} },
  ...NOT_OBJECTS,
]);

const recording = {
  id: 'rec',
  roomId: 'r',
  roomTitle: 'Room',
  host: 'h',
  status: 'ready',
  egressId: 'e',
  objectKey: 'k',
  startedAt: '2026',
  expiresAt: '2027',
  createdAt: '2026',
};

agree('recording', liveSchemas.ZRecording, live.recordingCheck, [
  recording,
  { ...recording, id: undefined, _id: 'legacy' },
  {
    ...recording,
    fileSize: null,
    durationMs: 1000,
    stoppedAt: null,
    access: 'participants',
    participantIds: ['a'],
    url: 'kept',
  },
  { ...recording, status: 'archived' },
  { ...recording, access: 'everyone' },
  ...NOT_OBJECTS,
]);

agree('start stream response', liveSchemas.ZStartStreamResponse, live.startStreamResponseCheck, [
  { ingressId: 'i', url: 'rtmp://x' },
  { ingressId: 'i', url: 'rtmp://x', ended: false },
  { ingressId: 'i' },
  ...NOT_OBJECTS,
]);

agree(
  'generate stream key response',
  liveSchemas.ZGenerateStreamKeyResponse,
  live.generateStreamKeyResponseCheck,
  [{ rtmpUrl: 'rtmp://x', streamKey: 'k' }, { rtmpUrl: 'rtmp://x' }, ...NOT_OBJECTS],
);
