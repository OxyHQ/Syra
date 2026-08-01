/**
 * Reading a MongoDB duplicate-key error as a decision rather than a failure.
 *
 * Several dedup paths here deliberately race the database and let the unique
 * index settle it: two uploads naming the same artist, two files carrying the
 * same release MBID, two taps uploading the same bytes. In every one of those
 * the `E11000` is the ANSWER — the loser reads it and uses the winner's row.
 *
 * The reason this is one module rather than a predicate per call site: knowing
 * an error is `E11000` is not enough to act on it. A create can violate several
 * unique indexes, and "an artist with that name already exists" (recover: fetch
 * it) is a completely different outcome from "an artist with that MusicBrainz id
 * already exists" (recover: fetch THAT one instead) or from a collision on an
 * index the caller was not expecting at all (recover: nothing — this is a bug,
 * and swallowing it would silently drop a write). A bare boolean makes all three
 * look alike, so the caller has to name which key it is prepared to lose on.
 */

/** The shape MongoDB's duplicate-key error actually arrives in. */
interface MongoDuplicateKeyError {
  code: number;
  /** Present on modern drivers: `{ nameKey: 'radiohead' }`. */
  keyValue?: Record<string, unknown>;
  /** The violated index, e.g. `nameKey_1`. Older drivers report it only in the message. */
  keyPattern?: Record<string, unknown>;
  message?: string;
}

function asDuplicateKeyError(err: unknown): MongoDuplicateKeyError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as MongoDuplicateKeyError;
  return candidate.code === 11000 ? candidate : undefined;
}

/** Is this a duplicate-key error at all? */
export function isDuplicateKeyError(err: unknown): boolean {
  return asDuplicateKeyError(err) !== undefined;
}

/**
 * The field paths whose uniqueness the write violated, e.g. `['nameKey']` or
 * `['externalIds.musicbrainzArtistId']`. Empty when the error is not `E11000`.
 *
 * Read from `keyPattern`/`keyValue` rather than parsed out of the message: the
 * message text is a driver-formatting detail and has changed between versions,
 * so matching on it is a check that stops working without failing.
 */
export function duplicateKeyFields(err: unknown): string[] {
  const duplicate = asDuplicateKeyError(err);
  if (!duplicate) return [];
  return Object.keys(duplicate.keyPattern ?? duplicate.keyValue ?? {});
}

/**
 * Did the write collide on THIS key, and only on keys the caller expected?
 *
 * Use this instead of a bare `code === 11000` wherever a collision is a
 * recoverable outcome. A collision on some OTHER unique index is not the
 * situation the recovery path was written for — treating it as one turns a bug
 * into a silently dropped write, which is the failure mode this signature
 * exists to make impossible.
 *
 * @example
 * try {
 *   return await ArtistModel.create({ name, nameKey, source: 'upload' });
 * } catch (err) {
 *   // Somebody else won the race; their row is the one to use.
 *   if (isDuplicateKeyOn(err, 'nameKey')) return ArtistModel.findOne({ nameKey });
 *   throw err;
 * }
 */
export function isDuplicateKeyOn(err: unknown, ...fields: string[]): boolean {
  const violated = duplicateKeyFields(err);
  if (violated.length === 0) return false;
  return violated.every((field) => fields.includes(field));
}
