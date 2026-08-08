/**
 * `series` and `series_episodes` — the recurring-show schedule.
 *
 * `Series.recurrence` and `Series.roomTemplate` were single subdocuments and are
 * flattened onto the parent row; `Series.episodes[]` was an array of objects and
 * is `series_episodes`. {@link SeriesView} reassembles the first two into the
 * nested shape the API has always returned, so the flattening is a storage
 * detail rather than a response change.
 *
 * ## The episode log outlives the rooms it points at
 *
 * `series_episodes.room_id` is `ON DELETE SET NULL`, not `CASCADE`: this is an
 * append-only history of what the series has scheduled, so deleting one
 * generated room must not erase the record that an episode N was scheduled at
 * all. An episode row with a null `roomId` is therefore normal and is serialized
 * with `roomId: null` rather than dropped.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { descNullsLast } from '../catalog/containers';
import { getDb, type DbOrTransaction } from '../postgres';
import { series, seriesEpisodes } from '../schema/rooms';
import { RecurrenceType, RoomType, SpeakerPermission } from './types';

export type SeriesRow = typeof series.$inferSelect;
export type SeriesEpisodeRow = typeof seriesEpisodes.$inferSelect;

export interface Recurrence {
  type: RecurrenceType;
  dayOfWeek?: number;
  dayOfMonth?: number;
  /** `HH:mm`, 24-hour. */
  time: string;
  /** An IANA timezone, e.g. `America/New_York`. */
  timezone: string;
}

export interface RoomTemplate {
  /** e.g. `Morning Talk - Episode {n}`. */
  titlePattern: string;
  type: RoomType;
  description?: string;
  maxParticipants: number;
  speakerPermission: SpeakerPermission;
  tags: string[];
}

export interface SeriesEpisodeView {
  roomId: string | null;
  scheduledStart: Date;
  episodeNumber: number;
}

/** A series in the nested shape the API returns. */
export interface SeriesView {
  id: string;
  title: string;
  description: string | null;
  coverImage: string | null;
  houseId: string | null;
  createdBy: string;
  recurrence: Recurrence;
  roomTemplate: RoomTemplate;
  episodes: SeriesEpisodeView[];
  nextEpisodeNumber: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Reassemble a flattened row plus its episode log into {@link SeriesView}. */
export function toSeriesView(
  row: SeriesRow,
  episodes: readonly SeriesEpisodeRow[],
): SeriesView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverImage: row.coverImage,
    houseId: row.houseId,
    createdBy: row.createdBy,
    recurrence: {
      type: row.recurrenceType as RecurrenceType,
      ...(row.recurrenceDayOfWeek === null ? {} : { dayOfWeek: row.recurrenceDayOfWeek }),
      ...(row.recurrenceDayOfMonth === null ? {} : { dayOfMonth: row.recurrenceDayOfMonth }),
      time: row.recurrenceTime,
      timezone: row.recurrenceTimezone,
    },
    roomTemplate: {
      titlePattern: row.roomTemplateTitlePattern,
      type: row.roomTemplateType as RoomType,
      ...(row.roomTemplateDescription === null
        ? {}
        : { description: row.roomTemplateDescription }),
      maxParticipants: row.roomTemplateMaxParticipants,
      speakerPermission: row.roomTemplateSpeakerPermission as SpeakerPermission,
      tags: row.roomTemplateTags,
    },
    episodes: episodes.map((episode) => ({
      roomId: episode.roomId,
      scheduledStart: episode.scheduledStart,
      episodeNumber: episode.episodeNumber,
    })),
    nextEpisodeNumber: row.nextEpisodeNumber,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────

export async function findSeriesById(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<SeriesRow | undefined> {
  const [row] = await db.select().from(series).where(eq(series.id, id)).limit(1);
  return row;
}

/** A series' episode log, in queue order. */
export async function findSeriesEpisodes(
  seriesId: string,
  db: DbOrTransaction = getDb(),
): Promise<SeriesEpisodeRow[]> {
  return db
    .select()
    .from(seriesEpisodes)
    .where(eq(seriesEpisodes.seriesId, seriesId))
    .orderBy(asc(seriesEpisodes.position));
}

/** One series in its full nested form. */
export async function findSeriesView(
  id: string,
  db: DbOrTransaction = getDb(),
): Promise<SeriesView | undefined> {
  const row = await findSeriesById(id, db);
  if (!row) return undefined;
  return toSeriesView(row, await findSeriesEpisodes(id, db));
}

/**
 * `GET /api/houses/:id/series` — the only series listing there is. Active only,
 * newest first, which is exactly what `series_house_id_active_created_at_idx`
 * is partial on.
 */
export async function listActiveSeriesForHouse(
  houseId: string,
  db: DbOrTransaction = getDb(),
): Promise<SeriesView[]> {
  const rows = await db
    .select()
    .from(series)
    .where(and(eq(series.houseId, houseId), eq(series.isActive, true)))
    .orderBy(descNullsLast(series.createdAt));

  if (rows.length === 0) return [];

  const episodes = await db
    .select()
    .from(seriesEpisodes)
    .where(inArray(seriesEpisodes.seriesId, rows.map((row) => row.id)))
    .orderBy(asc(seriesEpisodes.position));

  const byId = new Map<string, SeriesEpisodeRow[]>();
  for (const episode of episodes) {
    const existing = byId.get(episode.seriesId);
    if (existing) existing.push(episode);
    else byId.set(episode.seriesId, [episode]);
  }

  return rows.map((row) => toSeriesView(row, byId.get(row.id) ?? []));
}

// ── Writes ────────────────────────────────────────────────────────────────

export interface CreateSeriesInput {
  readonly title: string;
  readonly description?: string | null;
  readonly coverImage?: string | null;
  readonly houseId?: string | null;
  readonly createdBy: string;
  readonly recurrence: Recurrence;
  readonly roomTemplate: RoomTemplate;
}

export async function createSeries(
  input: CreateSeriesInput,
  db: DbOrTransaction = getDb(),
): Promise<SeriesRow> {
  const [row] = await db
    .insert(series)
    .values({
      title: input.title,
      description: input.description ?? null,
      coverImage: input.coverImage ?? null,
      houseId: input.houseId ?? null,
      createdBy: input.createdBy,
      recurrenceType: input.recurrence.type,
      recurrenceDayOfWeek: input.recurrence.dayOfWeek ?? null,
      recurrenceDayOfMonth: input.recurrence.dayOfMonth ?? null,
      recurrenceTime: input.recurrence.time,
      recurrenceTimezone: input.recurrence.timezone,
      roomTemplateTitlePattern: input.roomTemplate.titlePattern,
      roomTemplateType: input.roomTemplate.type,
      roomTemplateDescription: input.roomTemplate.description ?? null,
      roomTemplateMaxParticipants: input.roomTemplate.maxParticipants,
      roomTemplateSpeakerPermission: input.roomTemplate.speakerPermission,
      roomTemplateTags: input.roomTemplate.tags,
    })
    .returning();

  return row;
}

/**
 * Fields a series PATCH may change, already flattened.
 *
 * Flattened rather than nested because the route updates recurrence and
 * roomTemplate FIELD BY FIELD — `if (recurrence.time) series.recurrence.time =
 * …` — so a nested input type would force the caller to rebuild whole
 * subobjects and re-send fields it was not asked to change. `undefined` leaves
 * alone, `null` clears.
 */
export type UpdateSeriesInput = Partial<{
  title: string;
  description: string | null;
  coverImage: string | null;
  isActive: boolean;
  recurrenceType: RecurrenceType;
  recurrenceDayOfWeek: number | null;
  recurrenceDayOfMonth: number | null;
  recurrenceTime: string;
  recurrenceTimezone: string;
  roomTemplateTitlePattern: string;
  roomTemplateType: RoomType;
  roomTemplateDescription: string | null;
  roomTemplateMaxParticipants: number;
  roomTemplateSpeakerPermission: SpeakerPermission;
  roomTemplateTags: string[];
}>;

export async function updateSeries(
  id: string,
  input: UpdateSeriesInput,
  db: DbOrTransaction = getDb(),
): Promise<SeriesRow | undefined> {
  const [row] = await db
    .update(series)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(series.id, id))
    .returning();

  return row;
}

export async function deleteSeries(id: string, db: DbOrTransaction = getDb()): Promise<boolean> {
  const deleted = await db.delete(series).where(eq(series.id, id)).returning({ id: series.id });
  return deleted.length > 0;
}

/**
 * Append one generated episode and advance the series' counter.
 *
 * `position` is read as `count(*)` inside the same transaction so the
 * `(series_id, position)` unique constraint holds under concurrent generation,
 * and the counter bump is `next_episode_number + 1` in SQL rather than a
 * read-modify-write — two hosts generating at once would otherwise both write
 * the same number back.
 */
export async function appendSeriesEpisode(
  seriesId: string,
  roomId: string,
  scheduledStart: Date,
  episodeNumber: number,
  db: DbOrTransaction = getDb(),
): Promise<SeriesEpisodeRow> {
  return db.transaction(async (tx) => {
    const [{ position }] = await tx
      .select({ position: sql<number>`count(*)::int` })
      .from(seriesEpisodes)
      .where(eq(seriesEpisodes.seriesId, seriesId));

    const [episode] = await tx
      .insert(seriesEpisodes)
      .values({ seriesId, roomId, position, scheduledStart, episodeNumber })
      .returning();

    await tx
      .update(series)
      .set({ nextEpisodeNumber: sql`${series.nextEpisodeNumber} + 1`, updatedAt: new Date() })
      .where(eq(series.id, seriesId));

    return episode;
  });
}
