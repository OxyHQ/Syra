/**
 * Turning podcast and episode rows into DTOs — the batch reads `serialize.ts`
 * deliberately does not do itself.
 *
 * Same split, and the same reason, as `db/catalog/hydrate.ts`: `serialize.ts` is
 * pure so one page can share one image lookup and so it is testable without a
 * database, and somebody still has to LOAD the seven child collections and the
 * parent-show artwork. Everything here is a BATCH — a fixed number of queries
 * for a page of any size, and none at all for an empty one.
 *
 * ## Why every child collection is loaded, rather than opted into per surface
 *
 * `serializePodcast`/`serializeEpisode` under Mongo emitted `categories`,
 * `funding`, `persons`, `sources`, `transcripts` and `hls` on EVERY surface,
 * because they were embedded in the document and therefore free. They are joins
 * now, and the tempting saving is to load them only on detail surfaces.
 *
 * That is a behaviour regression, and Task 11 shipped exactly it once already
 * (`collaborators` dropped from the playlist LIST surface, where two frontend
 * screens derive edit rights from it). So the default here is parity: a page of
 * shows pays four extra indexed batch queries and a page of episodes three, all
 * keyed on the parent id, none per-row. A surface that genuinely wants less asks
 * for less — {@link PodcastChildren} and {@link EpisodeChildren} exist for that,
 * and the ONE caller using them today is the RSS generator, which renders its own
 * XML and never builds a DTO.
 *
 * ## `categories` keeps its feed order
 *
 * `Podcast.categories` was an ordered `string[]` and RSS declares the primary
 * category first, so the order is information. `podcast_categories` originally
 * shipped without the `position` column its six sibling child tables all carry,
 * which dropped that ordering at import with no way to recover it from the
 * table; the column was added in Task 12 and every read here orders by it.
 */

import { asc, eq, inArray } from 'drizzle-orm';
import type {
  Episode,
  EpisodePerson,
  EpisodeTranscript,
  HlsRendition,
  Podcast,
  PodcastFunding,
  PodcastPerson,
  PodcastSourceProvenance,
} from '@syra/shared-types';
import { getDb } from '../postgres';
import { genres } from '../schema/genres';
import {
  episodeHlsRenditions,
  episodePersons,
  episodeTranscripts,
  podcastCategories,
  podcastFunding,
  podcastPersons,
  podcastSources,
  podcasts,
} from '../schema/podcasts';
import { loadImageVariants } from '../catalog/hydrate';
import {
  episodeImageIds,
  podcastArtwork,
  podcastImageIds,
  toEpisodeDto,
  toPodcastDto,
  type EpisodeRow,
  type PodcastArtwork,
  type PodcastRow,
} from './serialize';

/** Which child collections a podcast page wants. Absent means all of them. */
export interface PodcastChildren {
  readonly categories?: boolean;
  readonly funding?: boolean;
  readonly persons?: boolean;
  readonly sources?: boolean;
}

/** Which child collections an episode page wants. Absent means all of them. */
export interface EpisodeChildren {
  readonly transcripts?: boolean;
  readonly persons?: boolean;
  readonly hls?: boolean;
}

/**
 * Group child rows by their parent id.
 *
 * A `Map` built in one pass rather than a `filter` per parent, which is the
 * quadratic shape a batch loader exists to avoid.
 */
function groupByParent<TRow, TValue>(
  rows: readonly TRow[],
  parentId: (row: TRow) => string,
  value: (row: TRow) => TValue
): Map<string, TValue[]> {
  const byParent = new Map<string, TValue[]>();
  for (const row of rows) {
    const key = parentId(row);
    const bucket = byParent.get(key);
    if (bucket) bucket.push(value(row));
    else byParent.set(key, [value(row)]);
  }
  return byParent;
}

/** Drop `null` values from a credit row, which the DTO declares `.optional()`. */
function toPersonDto(row: {
  name: string;
  role: string | null;
  group: string | null;
  img: string | null;
  href: string | null;
  linkedOxyUserId: string | null;
}): PodcastPerson {
  return {
    name: row.name,
    ...(row.role === null ? {} : { role: row.role }),
    ...(row.group === null ? {} : { group: row.group }),
    ...(row.img === null ? {} : { img: row.img }),
    ...(row.href === null ? {} : { href: row.href }),
    ...(row.linkedOxyUserId === null ? {} : { linkedOxyUserId: row.linkedOxyUserId }),
  };
}

// ── Podcast child collections ─────────────────────────────────────────────

/** Category NAMES per show, in the feed's own order — see the file-level doc comment. */
export async function loadPodcastCategories(
  podcastIds: readonly string[]
): Promise<Map<string, string[]>> {
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb()
    .select({ podcastId: podcastCategories.podcastId, name: genres.name })
    .from(podcastCategories)
    // `genre_id` alone identifies the row: the composite FK
    // `(genre_id, kind) -> genres(id, kind)` already guarantees the referenced
    // genre carries `kind = 'podcast'`, so restating it here would narrow
    // nothing and only invite the reader to wonder which of the two is load-bearing.
    .innerJoin(genres, eq(podcastCategories.genreId, genres.id))
    .where(inArray(podcastCategories.podcastId, [...podcastIds]))
    .orderBy(asc(podcastCategories.position));

  return groupByParent(rows, (row) => row.podcastId, (row) => row.name);
}

export async function loadPodcastFunding(
  podcastIds: readonly string[]
): Promise<Map<string, PodcastFunding[]>> {
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      podcastId: podcastFunding.podcastId,
      url: podcastFunding.url,
      message: podcastFunding.message,
    })
    .from(podcastFunding)
    .where(inArray(podcastFunding.podcastId, [...podcastIds]))
    .orderBy(asc(podcastFunding.position));

  return groupByParent(
    rows,
    (row) => row.podcastId,
    (row) => ({ url: row.url, ...(row.message === null ? {} : { message: row.message }) })
  );
}

export async function loadPodcastPersons(
  podcastIds: readonly string[]
): Promise<Map<string, PodcastPerson[]>> {
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(podcastPersons)
    .where(inArray(podcastPersons.podcastId, [...podcastIds]))
    .orderBy(asc(podcastPersons.position));

  return groupByParent(rows, (row) => row.podcastId, toPersonDto);
}

export async function loadPodcastSources(
  podcastIds: readonly string[]
): Promise<Map<string, PodcastSourceProvenance[]>> {
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(podcastSources)
    .where(inArray(podcastSources.podcastId, [...podcastIds]))
    .orderBy(asc(podcastSources.position));

  return groupByParent(
    rows,
    (row) => row.podcastId,
    (row) => ({
      provider: row.provider,
      externalId: row.externalId,
      importedAt: row.importedAt,
      fields: row.fields,
    })
  );
}

// ── Episode child collections ─────────────────────────────────────────────

export async function loadEpisodeTranscripts(
  episodeIds: readonly string[]
): Promise<Map<string, EpisodeTranscript[]>> {
  if (episodeIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(episodeTranscripts)
    .where(inArray(episodeTranscripts.episodeId, [...episodeIds]))
    .orderBy(asc(episodeTranscripts.position));

  return groupByParent(
    rows,
    (row) => row.episodeId,
    (row) => ({
      url: row.url,
      type: row.type,
      ...(row.language === null ? {} : { language: row.language }),
    })
  );
}

export async function loadEpisodePersons(
  episodeIds: readonly string[]
): Promise<Map<string, EpisodePerson[]>> {
  if (episodeIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(episodePersons)
    .where(inArray(episodePersons.episodeId, [...episodeIds]))
    .orderBy(asc(episodePersons.position));

  return groupByParent(rows, (row) => row.episodeId, toPersonDto);
}

export async function loadEpisodeHls(
  episodeIds: readonly string[]
): Promise<Map<string, HlsRendition[]>> {
  if (episodeIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(episodeHlsRenditions)
    .where(inArray(episodeHlsRenditions.episodeId, [...episodeIds]))
    .orderBy(asc(episodeHlsRenditions.position));

  return groupByParent(
    rows,
    (row) => row.episodeId,
    (row) => ({
      manifestKey: row.manifestKey,
      bitrateKbps: row.bitrateKbps,
      encrypted: row.encrypted,
    })
  );
}

// ── Parent-show artwork ───────────────────────────────────────────────────

/**
 * The inheritable artwork of a set of shows, keyed by show id.
 *
 * The replacement for `services/podcasts/episodeShowArtwork.ts`: ONE query over
 * the DISTINCT parent ids plus one for their image assets, never one per
 * episode. Episodes whose show is missing get no inherited artwork, which leaves
 * their own absent cover unchanged — the Mongo helper's behaviour exactly.
 */
export async function loadShowArtwork(
  episodeRows: readonly { podcastId: string }[]
): Promise<Map<string, PodcastArtwork>> {
  const podcastIds = [...new Set(episodeRows.map((row) => row.podcastId))];
  if (podcastIds.length === 0) return new Map();

  const rows = await getDb().select().from(podcasts).where(inArray(podcasts.id, podcastIds));
  const lookup = await loadImageVariants(rows.flatMap(podcastImageIds));

  return new Map(rows.map((row) => [row.id, podcastArtwork(row, lookup)]));
}

// ── Page serialization ────────────────────────────────────────────────────

/**
 * Serialize a page of shows.
 *
 * Five queries regardless of page size: the image assets behind every referenced
 * variant, and one per child collection.
 */
export async function toPodcastDtos(
  rows: readonly PodcastRow[],
  children: PodcastChildren = {}
): Promise<Podcast[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const want = <K extends keyof PodcastChildren>(key: K): boolean => children[key] !== false;

  const [lookup, categories, funding, persons, sources] = await Promise.all([
    loadImageVariants(rows.flatMap(podcastImageIds)),
    want('categories') ? loadPodcastCategories(ids) : Promise.resolve(new Map<string, string[]>()),
    want('funding') ? loadPodcastFunding(ids) : Promise.resolve(new Map<string, PodcastFunding[]>()),
    want('persons') ? loadPodcastPersons(ids) : Promise.resolve(new Map<string, PodcastPerson[]>()),
    want('sources')
      ? loadPodcastSources(ids)
      : Promise.resolve(new Map<string, PodcastSourceProvenance[]>()),
  ]);

  return rows.map((row) =>
    toPodcastDto(row, lookup, {
      /**
       * `?? []` rather than `?? undefined`, and the difference is on the wire: a
       * show with no funding rows had an EMPTY ARRAY in Mongo (the schema
       * declared `funding: [...]`, and Mongoose materialises a declared array
       * path as `[]` rather than leaving it absent), so a client distinguishing
       * "no funding" from "not loaded" keeps getting the same answer.
       */
      categories: want('categories') ? (categories.get(row.id) ?? []) : undefined,
      funding: want('funding') ? (funding.get(row.id) ?? []) : undefined,
      persons: want('persons') ? (persons.get(row.id) ?? []) : undefined,
      sources: want('sources') ? (sources.get(row.id) ?? []) : undefined,
    })
  );
}

/**
 * Serialize a page of episodes, resolving each one's parent-show artwork.
 *
 * `showArtwork` is passed in when the caller already loaded the show (a show
 * detail page has it in hand and must not re-query it); omitted, this loads it
 * for the distinct parents in one batch.
 */
export async function toEpisodeDtos(
  rows: readonly EpisodeRow[],
  showArtwork?: ReadonlyMap<string, PodcastArtwork>,
  children: EpisodeChildren = {}
): Promise<Episode[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const want = <K extends keyof EpisodeChildren>(key: K): boolean => children[key] !== false;

  const [lookup, artwork, transcripts, persons, hls] = await Promise.all([
    loadImageVariants(rows.flatMap(episodeImageIds)),
    showArtwork ? Promise.resolve(showArtwork) : loadShowArtwork(rows),
    want('transcripts')
      ? loadEpisodeTranscripts(ids)
      : Promise.resolve(new Map<string, EpisodeTranscript[]>()),
    want('persons') ? loadEpisodePersons(ids) : Promise.resolve(new Map<string, EpisodePerson[]>()),
    want('hls') ? loadEpisodeHls(ids) : Promise.resolve(new Map<string, HlsRendition[]>()),
  ]);

  return rows.map((row) =>
    toEpisodeDto(row, lookup, artwork.get(row.podcastId), {
      transcripts: want('transcripts') ? (transcripts.get(row.id) ?? []) : undefined,
      persons: want('persons') ? (persons.get(row.id) ?? []) : undefined,
      hls: want('hls') ? (hls.get(row.id) ?? []) : undefined,
    })
  );
}
