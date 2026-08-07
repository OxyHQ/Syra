/**
 * `user_music_preferences` — one row per Oxy account, on drizzle.
 *
 * Eleven scalar columns and no relationships: the flattest table in this
 * vertical, and a straight 1:1 port of `models/UserMusicPreferences.ts`.
 *
 * ## Why the clamping lives here rather than in the route
 *
 * The route used to validate each field before writing it — `Math.max(0,
 * Math.min(1, volume))`, an `includes` against the audio-quality tuple. Every one
 * of those bounds is now also a CHECK constraint (`schema/user.ts`), so the two
 * express the same rule and belong beside each other: a clamp that drifted from
 * its constraint would turn a request the API used to accept into a `23514` the
 * caller cannot act on. {@link coerceMusicPreferencesPatch} is that one place.
 *
 * Clamping rather than rejecting is the ported behaviour, not a new choice — the
 * Mongo route silently clamped an out-of-range volume and silently ignored an
 * unknown audio quality, and clients depend on neither being an error.
 *
 * This module replaces `controllers/musicPreferences.controller.ts`, which held
 * no request handling at all: it was three data-access functions living under
 * `controllers/`. Its two other readers (`stream.controller`, `radio.controller`)
 * each ran their own `findOne` against the model and now share
 * {@link findMusicPreferences}.
 */

import { eq } from 'drizzle-orm';
import type { AudioQuality } from '@syra/shared-types';
import { getDb, type DbOrTransaction } from '../postgres';
import { AUDIO_QUALITIES, userMusicPreferences } from '../schema/user';

/** One account's preferences, exactly the columns the table holds. */
export type MusicPreferencesRow = typeof userMusicPreferences.$inferSelect;

/**
 * The document the API returns — the row without its surrogate `id`.
 *
 * `models/UserMusicPreferences.ts` exposed `_id` on the wire because it returned
 * a lean document whole. Nothing reads it: `frontend/hooks/useMusicPreferences`
 * parses the named fields, and the row's identity is `oxyUserId`.
 */
export type MusicPreferencesDto = Omit<MusicPreferencesRow, 'id'>;

const DTO_COLUMNS = {
  oxyUserId: userMusicPreferences.oxyUserId,
  defaultVolume: userMusicPreferences.defaultVolume,
  autoplay: userMusicPreferences.autoplay,
  crossfade: userMusicPreferences.crossfade,
  gaplessPlayback: userMusicPreferences.gaplessPlayback,
  normalizeVolume: userMusicPreferences.normalizeVolume,
  explicitContent: userMusicPreferences.explicitContent,
  audioQuality: userMusicPreferences.audioQuality,
  downloadQuality: userMusicPreferences.downloadQuality,
  dataSaver: userMusicPreferences.dataSaver,
  monoAudio: userMusicPreferences.monoAudio,
  createdAt: userMusicPreferences.createdAt,
  updatedAt: userMusicPreferences.updatedAt,
} as const;

/** The columns {@link coerceMusicPreferencesPatch} may produce. */
export type MusicPreferencesPatch = Partial<
  Pick<
    MusicPreferencesRow,
    | 'defaultVolume'
    | 'autoplay'
    | 'crossfade'
    | 'gaplessPlayback'
    | 'normalizeVolume'
    | 'explicitContent'
    | 'audioQuality'
    | 'downloadQuality'
    | 'dataSaver'
    | 'monoAudio'
  >
>;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isAudioQuality(value: unknown): value is AudioQuality {
  return typeof value === 'string' && (AUDIO_QUALITIES as readonly string[]).includes(value);
}

/**
 * Take a client body apart into a column patch, dropping anything of the wrong
 * type and clamping anything out of range.
 *
 * No property is ever set to `null`: this table has no nullable column and no
 * "clear" operation — every field has a default and an absent property means
 * "leave alone", which is what `buildUpdateSet` does with an undefined value.
 */
export function coerceMusicPreferencesPatch(input: unknown): MusicPreferencesPatch {
  const body: Record<string, unknown> = typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)
    : {};
  const patch: MusicPreferencesPatch = {};

  if (typeof body.defaultVolume === 'number') patch.defaultVolume = clamp(body.defaultVolume, 0, 1);
  if (typeof body.autoplay === 'boolean') patch.autoplay = body.autoplay;
  if (typeof body.crossfade === 'number') patch.crossfade = clamp(body.crossfade, 0, 12);
  if (typeof body.gaplessPlayback === 'boolean') patch.gaplessPlayback = body.gaplessPlayback;
  if (typeof body.normalizeVolume === 'boolean') patch.normalizeVolume = body.normalizeVolume;
  if (typeof body.explicitContent === 'boolean') patch.explicitContent = body.explicitContent;
  if (isAudioQuality(body.audioQuality)) patch.audioQuality = body.audioQuality;
  if (isAudioQuality(body.downloadQuality)) patch.downloadQuality = body.downloadQuality;
  if (typeof body.dataSaver === 'boolean') patch.dataSaver = body.dataSaver;
  if (typeof body.monoAudio === 'boolean') patch.monoAudio = body.monoAudio;

  return patch;
}

/** One account's preferences, or `undefined` when they have never had a row. */
export async function findMusicPreferences(
  oxyUserId: string,
  db: DbOrTransaction = getDb(),
): Promise<MusicPreferencesDto | undefined> {
  const [row] = await db
    .select(DTO_COLUMNS)
    .from(userMusicPreferences)
    .where(eq(userMusicPreferences.oxyUserId, oxyUserId))
    .limit(1);
  return row;
}

/**
 * One account's preferences, creating the row with defaults on first read.
 *
 * The Mongo version listed all eleven defaults at the call site, duplicating the
 * schema's own. Every column here carries its default, so the insert names only
 * `oxyUserId` and the two cannot disagree.
 */
export async function ensureMusicPreferences(oxyUserId: string): Promise<MusicPreferencesDto> {
  const existing = await findMusicPreferences(oxyUserId);
  if (existing) return existing;

  await getDb().insert(userMusicPreferences).values({ oxyUserId }).onConflictDoNothing();

  const created = await findMusicPreferences(oxyUserId);
  if (!created) {
    throw new Error(`user_music_preferences row for ${oxyUserId} vanished between insert and read`);
  }
  return created;
}

/** Apply a patch, creating the row when the account has none. */
export async function updateMusicPreferences(
  oxyUserId: string,
  patch: MusicPreferencesPatch,
): Promise<MusicPreferencesDto> {
  const [row] = await getDb()
    .insert(userMusicPreferences)
    .values({ oxyUserId, ...patch })
    .onConflictDoUpdate({
      target: userMusicPreferences.oxyUserId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning(DTO_COLUMNS);

  return row;
}
