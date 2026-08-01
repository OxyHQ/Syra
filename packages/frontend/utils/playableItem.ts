import type { PlayableItem, Track, UserUploadAsTrack } from '@syra/shared-types';

/**
 * The catalog → player boundary: where an untagged track becomes a tagged one.
 *
 * The queue and the stream resolver address items by `{ kind, id }` because they
 * span two collections — the public catalog and a listener's private locker —
 * and the kind decides which endpoint, and therefore which access check, applies.
 * Screens on the catalog side hold values that predate the tag, so it is
 * completed exactly here rather than at each of the ~30 places one is played or
 * queued.
 */

/**
 * What a screen may hand the player or the queue.
 *
 * The asymmetry is what makes the union safe. A catalog screen holds a bare
 * `Track` — untagged, because every catalog serializer predates the kind tag —
 * while a locker file is a `UserUploadAsTrack`, whose `kind: 'upload'` is
 * REQUIRED by its own type and written by the backend serializer. So the only
 * value that can arrive here without a tag is a catalog track, and
 * {@link toPlayableItem} can complete that one without ever being able to
 * mislabel the other.
 */
export type PlayableInput = Track | UserUploadAsTrack;

/**
 * Complete a caller's item into the tagged form the queue and the resolver use.
 *
 * The `=== 'upload'` test is deliberate, not defensive: `'kind' in item` alone
 * would hand back an already-tagged CATALOG track under the upload arm's type,
 * which typechecks and is a lie. Only an actual upload keeps its tag; everything
 * else — untagged, or already tagged `'track'` — is stated as catalog.
 */
export function toPlayableItem(item: PlayableInput): PlayableItem {
  return 'kind' in item && item.kind === 'upload' ? item : { ...item, kind: 'track' };
}
