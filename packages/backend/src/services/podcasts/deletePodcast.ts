/**
 * Deleting a Syra-hosted show, or one episode of it — bytes and rows, in that
 * order.
 *
 * The row half and its cascade are `db/podcasts/delete.ts`. This module owns the
 * two things that module deliberately does not decide: WHICH stored objects
 * belong to an episode, and WHICH ORDER the two halves run in.
 *
 * ## Bytes first, then the row — and which failure that chooses
 *
 * The two halves cannot be made atomic: S3 is not in the transaction. So one of
 * two partial states is possible after a crash between them, and the order picks
 * which:
 *
 *  - ROW first — a show that is gone from the API while its audio stays in the
 *    bucket. Unrecoverable, because the keys naming those objects lived in the
 *    row that was just deleted: no retry can ever find them again. It is also
 *    the exact shape of the complaint this feature answers — content deleted in
 *    one place and still sitting in another.
 *  - BYTES first — a show whose row survives with dead audio. Visible to its
 *    owner, retryable (pressing delete again finishes the job), and at no point
 *    is anything of theirs still being served.
 *
 * So: bytes first. The failure we choose to be possible is a show that is still
 * listed but broken, never one that is gone but still published.
 *
 * `unpublishFirst` narrows even that. Setting `status = 'unavailable'` before a
 * single object is deleted takes the show off browse, search, its detail page
 * and its RSS feed (`reachableShowFilter`), so the broken-but-visible window
 * exists only for the owner, who is the person who asked for this. It is the
 * same soft state `unpublishPodcast` already writes, used here as a step rather
 * than as a destination — the destination is still no row at all.
 *
 * ## Storage side effects are injectable
 *
 * Exactly as `compliance/takedown.ts` does it, and for the same reason: a test
 * has to be able to assert WHICH keys a delete asks S3 for without an S3
 * endpoint, and "the row is gone" is not evidence that the audio is. Production
 * passes nothing and gets the real client.
 */

import {
  getS3PodcastEpisodeAudioKey,
  getS3PodcastEpisodeHlsPrefix,
  getS3PodcastShowPrefixes,
} from '../../config/s3.config';
import {
  deleteEpisodeRow,
  deletePodcastRow,
  findEpisodeStorageRef,
  findEpisodeStorageRefsByShow,
  type EpisodeStorageRef,
} from '../../db/podcasts/delete';
import { updatePodcast as updatePodcastRow } from '../../db/podcasts/podcasts';
import { deleteFromS3, deleteS3Prefix } from '../s3Service';
import { logger } from '../../utils/logger';

/**
 * Storage side effects, injectable so a test can assert the KEYS without an S3
 * endpoint. See the module comment.
 */
export interface PodcastPurgeDeps {
  deleteObject?: (key: string) => Promise<void>;
  deletePrefix?: (prefix: string) => Promise<number>;
}

export interface PodcastDeleteResult {
  /** Stored objects deleted — source audio, manifests, and every segment beside them. */
  objectsDeleted: number;
  /** Episodes whose storage was purged. Zero for a show that never had one. */
  episodesPurged: number;
}

/**
 * Every stored object one episode records a key for.
 *
 * The source audio is DERIVED rather than read, and that is forced: the column
 * `audioSourceUrl` holds an API path (`/api/podcasts/episodes/{id}/audio`), not
 * an S3 key, so the key exists nowhere in the row. It is derived through
 * `getS3PodcastEpisodeAudioKey` — the same function `uploadEpisode` and
 * `ingestEpisodeAudio` write with — so there is one spelling of that layout
 * rather than two that can drift. An episode with no `audioSourceFormat` was
 * never ingested and has no source object to name.
 *
 * Deriving a single OBJECT key from a convention is a different risk from
 * deriving a PREFIX: if the layout ever changed, this would delete nothing and
 * leave an orphan, where a wrong prefix would delete somebody else's files.
 */
function recordedObjectKeys(episode: EpisodeStorageRef): string[] {
  const keys: string[] = [];

  if (episode.audioSourceFormat) {
    keys.push(getS3PodcastEpisodeAudioKey(episode.id, episode.podcastId, episode.audioSourceFormat));
  }
  if (episode.hlsMasterKey) keys.push(episode.hlsMasterKey);
  if (episode.cacheObjectKey) keys.push(episode.cacheObjectKey);
  if (episode.cacheHlsMasterKey) keys.push(episode.cacheHlsMasterKey);
  keys.push(...episode.hlsManifestKeys);

  return [...new Set(keys)];
}

/**
 * Delete everything ONE episode has in storage, and say how many objects went.
 *
 * The HLS directory is swept as a prefix because only the manifests are
 * recorded — the segments beside them are named by the packager and stored
 * nowhere, so deleting the recorded keys alone would leave the actual audio in
 * the bucket. `getS3PodcastEpisodeHlsPrefix` is the episode's own two-segment
 * directory (`hls/{podcastId}/{episodeId}/`), derived from the key builder
 * ingest writes with, so it cannot reach a sibling episode of the same show.
 *
 * That episode-scoped prefix is the whole difference between deleting one
 * episode and deleting its show: sweeping `hls/{podcastId}/` from here would
 * take every SIBLING episode's audio with it, and nothing about the resulting
 * call would look wrong. The show delete sweeps that wider tree deliberately;
 * this one must never be able to.
 */
export async function deleteEpisodeStoredObjects(
  episode: EpisodeStorageRef,
  deps: PodcastPurgeDeps = {}
): Promise<number> {
  const deletePrefix = deps.deletePrefix ?? deleteS3Prefix;
  const prefix = getS3PodcastEpisodeHlsPrefix(episode.podcastId, episode.id);

  const deleted = await deletePrefix(prefix);
  return deleted + (await deleteRecordedKeysOutside(episode, [prefix], deps));
}

/**
 * Delete the keys an episode records that no already-swept prefix covers.
 *
 * Split out because the show delete sweeps the show's whole trees and must NOT
 * then re-list each episode's directory inside them — that is one S3 listing per
 * episode to discover an empty directory. What it still owes is any recorded key
 * pointing OUTSIDE those trees, which a prefix sweep by definition cannot reach.
 */
async function deleteRecordedKeysOutside(
  episode: EpisodeStorageRef,
  sweptPrefixes: readonly string[],
  deps: PodcastPurgeDeps
): Promise<number> {
  const deleteObject = deps.deleteObject ?? deleteFromS3;
  let deleted = 0;

  for (const key of recordedObjectKeys(episode)) {
    if (sweptPrefixes.some((prefix) => key.startsWith(prefix))) continue;
    await deleteObject(key);
    deleted += 1;
  }

  return deleted;
}

/**
 * Delete one episode: its bytes, then its row and the show counters that
 * describe it.
 *
 * Returns undefined when no such episode exists, so a caller answers 404 rather
 * than reporting a delete that never happened. Ownership is NOT checked here —
 * the controller has already resolved the show and applied
 * `source === 'syra'` + owner, and a service that re-derived that rule would be
 * a second authority able to disagree with the first.
 */
export async function deleteEpisodeCompletely(
  episodeId: string,
  deps: PodcastPurgeDeps = {}
): Promise<PodcastDeleteResult | undefined> {
  const episode = await findEpisodeStorageRef(episodeId);
  if (!episode) return undefined;

  const objectsDeleted = await deleteEpisodeStoredObjects(episode, deps);
  const removed = await deleteEpisodeRow(episodeId);
  if (!removed) return undefined;

  logger.info('[podcasts] episode deleted', {
    episodeId,
    podcastId: episode.podcastId,
    objectsDeleted,
  });

  return { objectsDeleted, episodesPurged: 1 };
}

/**
 * Delete a whole show: hide it, sweep its three storage trees, delete any
 * recorded key that lies outside them, then delete the row and let the cascade
 * run.
 *
 * The sweep is by SHOW prefix rather than episode by episode, and it is not
 * merely the cheaper of two equivalent passes. A per-episode pass can only
 * delete what a row still names, so an episode whose ingest died between
 * uploading its audio and recording the key — or whose rendition rows were
 * replaced by a re-ingest — leaves objects no row points at. Those are exactly
 * the objects that would survive for ever once the rows are gone, and a
 * show-scoped prefix is the only thing that can still find them. It also costs
 * three S3 listings instead of one per episode.
 *
 * The per-episode loop that follows owes only what a prefix cannot reach: a
 * recorded key pointing outside the show's own trees.
 *
 * Returns undefined when the row was already gone — a second delete of the same
 * show is a 404, not a success and not a 500.
 */
export async function deletePodcastCompletely(
  podcastId: string,
  deps: PodcastPurgeDeps = {}
): Promise<PodcastDeleteResult | undefined> {
  const deletePrefix = deps.deletePrefix ?? deleteS3Prefix;

  /**
   * Off the shelves before anything is destroyed. If the purge below dies
   * halfway, what is left is an unpublished show with some dead episodes —
   * reachable only by its owner, who can press delete again — rather than a
   * listed show serving 404s to strangers mid-playback.
   */
  await updatePodcastRow(podcastId, { status: 'unavailable' });

  const episodes = await findEpisodeStorageRefsByShow(podcastId);
  const showPrefixes = getS3PodcastShowPrefixes(podcastId);

  let objectsDeleted = 0;
  for (const prefix of showPrefixes) {
    objectsDeleted += await deletePrefix(prefix);
  }

  for (const episode of episodes) {
    objectsDeleted += await deleteRecordedKeysOutside(episode, showPrefixes, deps);
  }

  const removed = await deletePodcastRow(podcastId);
  if (!removed) return undefined;

  logger.info('[podcasts] show deleted', {
    podcastId,
    episodesPurged: episodes.length,
    objectsDeleted,
  });

  return { objectsDeleted, episodesPurged: episodes.length };
}
