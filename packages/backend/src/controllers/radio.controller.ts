import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import type { Response, NextFunction } from 'express';
import { z } from 'zod';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import {
  radioSeedTypeSchema,
  type RadioGate,
  type RadioPage,
  type RadioSeedType,
  type RadioStation,
} from '@syra/shared-types';
import { TrackModel } from '../models/Track';
import { UserMusicPreferencesModel } from '../models/UserMusicPreferences';
import { PREVIEW_DURATION_SEC } from '../services/ingest/previewClip';
import { decodeRadioCursor, encodeRadioCursor, RADIO_CURSOR_VERSION } from '../services/radio/radioCursor';
import { buildRadioPage, type RadioTrackDoc } from '../services/radio/radioPools';
import { loadRadioTaste, resolveRadioSeed, type SeedResolution } from '../services/radio/radioSeed';
import {
  clearRadioStation,
  findServedPage,
  readRadioStation,
  recordServedPage,
  writeRadioStation,
  type RadioStationIdentity,
  type RadioStationState,
} from '../services/radio/radioStationStore';
import { orderByIds } from '../services/recommendations/taste';
import { getRequestUserId, playableTrackFilter } from '../utils/catalogVisibility';
import { isDatabaseConnected } from '../utils/database';
import { formatTracksWithCoverArt } from '../utils/musicHelpers';

/**
 * The HTTP surface of the radio engine.
 *
 * Every station is generated per-request against server-held state, so this
 * endpoint is the one catalog route that must never be cached — see
 * {@link RADIO_CACHE_CONTROL}.
 */

const RADIO_DEFAULT_PAGE_SIZE = 20;
const RADIO_MIN_PAGE_SIZE = 1;
const RADIO_MAX_PAGE_SIZE = 50;

/**
 * Radio mutates server state on every read: it records what it handed out so the
 * next page does not repeat it. A cached response would serve one listener's
 * page to another and silently desynchronise the station from its served set —
 * deliberately unlike the discovery handlers, which are pure reads and DO carry
 * a public cache.
 */
const RADIO_CACHE_CONTROL = 'no-store';

/** How many tracks a signed-out listener may be programmed before the wall closes. */
export const GUEST_PREVIEW_TRACK_LIMIT = 3;

/**
 * A guest hears 30-second previews, never full tracks, so the gate rides along
 * with every guest response — not only the walled one.
 */
const GUEST_GATE: RadioGate = {
  reason: 'guest-preview-limit',
  previewSeconds: PREVIEW_DURATION_SEC,
};

const GUEST_DEVICE_HEADER = 'x-syra-device-id';

/** Owner key for a guest that sent no device id — a shared, deliberately crowded bucket. */
const ANONYMOUS_OWNER_KEY = 'g:anon';

/** Bytes of the device-id digest kept in the owner key. Collision-safe, key-length friendly. */
const GUEST_KEY_LENGTH = 24;

const radioPageQuerySchema = z
  .object({
    seedType: radioSeedTypeSchema.optional(),
    seedId: z.string().trim().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(RADIO_MIN_PAGE_SIZE)
      .max(RADIO_MAX_PAGE_SIZE)
      .default(RADIO_DEFAULT_PAGE_SIZE),
  })
  .refine((value) => value.cursor !== undefined || value.seedType !== undefined, {
    message: 'seedType is required when no cursor is given',
    path: ['seedType'],
  })
  .refine(
    (value) => value.cursor !== undefined || value.seedType === 'user' || value.seedId !== undefined,
    { message: 'seedId is required for this seedType', path: ['seedId'] }
  );

const radioClearQuerySchema = z
  .object({
    seedType: radioSeedTypeSchema,
    seedId: z.string().trim().min(1).optional(),
  })
  .refine((value) => value.seedType === 'user' || value.seedId !== undefined, {
    message: 'seedId is required for this seedType',
    path: ['seedId'],
  });

/** The station a request is asking for, once cursor and query params agree. */
interface RequestedStation {
  seedType: RadioSeedType;
  seedId: string;
  page: number;
}

/** The listener, as the station store keys them. */
interface RadioListener {
  ownerKey: string;
  /** `undefined` for a guest. */
  oxyUserId?: string;
}

function headerValue(req: AuthRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Derive the key a station is stored under.
 *
 * NOT A SECURITY BOUNDARY. A guest can rotate `X-Syra-Device-Id` at will and get
 * a fresh bucket, and one that sends no header shares `g:anon` with every other
 * such guest. That is acceptable because the counter this key scopes is a UX
 * gate, not an entitlement: real playback is gated by `/api/stream` requiring a
 * bearer session, and what a guest can reach without one is physically a
 * 30-second preview clip. Rotating the device id buys a guest more 30-second
 * previews of a public catalog — which they could already fetch by hand.
 *
 * The id is hashed rather than stored raw so a Redis dump never carries a
 * client-chosen identifier verbatim.
 */
function resolveListener(req: AuthRequest): RadioListener {
  const oxyUserId = getRequestUserId(req);
  if (oxyUserId) {
    return { ownerKey: `u:${oxyUserId}`, oxyUserId };
  }

  const deviceId = headerValue(req, GUEST_DEVICE_HEADER);
  if (!deviceId) {
    return { ownerKey: ANONYMOUS_OWNER_KEY };
  }

  const digest = createHash('sha256').update(deviceId).digest('hex').slice(0, GUEST_KEY_LENGTH);
  return { ownerKey: `g:${digest}` };
}

function toStation(
  seed: SeedResolution,
  identity: RadioStationIdentity,
  state: RadioStationState
): RadioStation {
  return {
    seedType: identity.seedType,
    seedId: identity.seedId,
    title: seed.title,
    subtitle: seed.subtitle,
    ...(seed.imageUrl ? { imageUrl: seed.imageUrl } : {}),
    personalized: seed.personalized,
    wrapped: state.wrappedAt !== undefined,
  };
}

function nextCursor(identity: RadioStationIdentity, page: number): string {
  return encodeRadioCursor({
    v: RADIO_CURSOR_VERSION,
    seedType: identity.seedType,
    seedId: identity.seedId,
    page: page + 1,
  });
}

/**
 * Re-read a memoised page. Playability is re-checked rather than trusted: a
 * track struck since it was served must not come back on a retry.
 */
async function loadServedTracks(trackIds: string[]): Promise<RadioTrackDoc[]> {
  const ids = trackIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) {
    return [];
  }

  const docs = await TrackModel.find(playableTrackFilter({ _id: { $in: ids } })).lean();
  return orderByIds(docs, ids);
}

/**
 * GET /api/radio
 *
 * One page of a station, seeded by `seedType`/`seedId` or resumed from `cursor`.
 * Optional auth: a signed-in listener gets a taste-ordered, unlimited station; a
 * guest gets {@link GUEST_PREVIEW_TRACK_LIMIT} tracks of 30-second previews.
 */
export const getRadioPage = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', RADIO_CACHE_CONTROL);

    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const parsed = radioPageQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid radio request',
        details: parsed.error.issues,
      });
    }

    let requested: RequestedStation;
    if (parsed.data.cursor !== undefined) {
      // A cursor supersedes the seed params entirely — it names the station.
      const cursor = decodeRadioCursor(parsed.data.cursor);
      if (!cursor) {
        return res.status(400).json({ error: 'Invalid radio cursor' });
      }
      requested = { seedType: cursor.seedType, seedId: cursor.seedId, page: cursor.page };
    } else if (parsed.data.seedType !== undefined) {
      requested = {
        seedType: parsed.data.seedType,
        // A personalised station is seeded by the listener, so it points at nothing.
        seedId: parsed.data.seedType === 'user' ? '' : parsed.data.seedId ?? '',
        page: 0,
      };
    } else {
      return res.status(400).json({ error: 'seedType is required when no cursor is given' });
    }

    const listener = resolveListener(req);
    const guest = listener.oxyUserId === undefined;
    const identity: RadioStationIdentity = {
      seedType: requested.seedType,
      seedId: requested.seedId,
      ownerKey: listener.ownerKey,
    };

    const [state, seed] = await Promise.all([
      readRadioStation(identity),
      resolveRadioSeed({ seedType: requested.seedType, seedId: requested.seedId }, listener.oxyUserId),
    ]);

    if (!seed) {
      return res.status(404).json({ error: 'Radio station not found' });
    }

    const station = toStation(seed, identity, state);

    // The guest allowance is checked before anything else the station could hand
    // out, including a memoised replay: the wall must close sooner, never later.
    const guestAllowance = guest
      ? GUEST_PREVIEW_TRACK_LIMIT - state.guestServedCount
      : Number.POSITIVE_INFINITY;

    if (guestAllowance <= 0) {
      return res.json({ station, tracks: [], cursor: null, gate: GUEST_GATE } satisfies RadioPage);
    }

    // A page already handed out replays verbatim instead of programming a new
    // one, so a client retry after a dropped response cannot burn a page of
    // catalog it never showed anyone.
    const memoised = findServedPage(state, requested.page);
    if (memoised) {
      const docs = await loadServedTracks(memoised.trackIds);
      const tracks: RadioPage['tracks'] = await formatTracksWithCoverArt(docs);
      return res.json({
        station,
        tracks,
        cursor: tracks.length > 0 ? nextCursor(identity, requested.page) : null,
        gate: guest ? GUEST_GATE : null,
      } satisfies RadioPage);
    }

    const [taste, preferences] = await Promise.all([
      loadRadioTaste(listener.oxyUserId),
      listener.oxyUserId
        ? UserMusicPreferencesModel.findOne({ oxyUserId: listener.oxyUserId }).lean()
        : Promise.resolve(null),
    ]);

    const result = await buildRadioPage({
      seed,
      state,
      page: requested.page,
      // A guest is never programmed past their allowance, so the wall means three
      // tracks rather than three pages.
      limit: Math.min(parsed.data.limit, guestAllowance),
      taste,
      // Listener preference, not availability. Unset defaults to allowed, matching
      // the model default.
      allowExplicit: preferences?.explicitContent !== false,
    });

    const servedTrackIds = result.tracks.map((doc) => doc._id.toString());
    const served = recordServedPage(result.state, requested.page, servedTrackIds, {
      guest,
      wrapped: result.wrapped,
    });
    await writeRadioStation(served);

    const exhausted = guest && served.guestServedCount >= GUEST_PREVIEW_TRACK_LIMIT;
    const tracks: RadioPage['tracks'] = await formatTracksWithCoverArt(result.tracks);

    return res.json({
      station: toStation(seed, identity, served),
      tracks,
      // A station closes when it has nothing left to give, or when the guest
      // allowance ran out on this very page.
      cursor: tracks.length > 0 && !exhausted ? nextCursor(identity, requested.page) : null,
      gate: guest ? GUEST_GATE : null,
    } satisfies RadioPage);
  } catch (error) {
    next(error);
  }
};

/**
 * DELETE /api/radio?seedType=&seedId=
 *
 * Forget a station — its served set, its pages and its guest counter — so the
 * next request programmes it from scratch. Touches Redis only, so it stays
 * available while Mongo is down.
 */
export const clearRadio = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.set('Cache-Control', RADIO_CACHE_CONTROL);

    const parsed = radioClearQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid radio request',
        details: parsed.error.issues,
      });
    }

    const listener = resolveListener(req);
    await clearRadioStation({
      seedType: parsed.data.seedType,
      seedId: parsed.data.seedType === 'user' ? '' : parsed.data.seedId ?? '',
      ownerKey: listener.ownerKey,
    });

    return res.status(204).send();
  } catch (error) {
    next(error);
  }
};
