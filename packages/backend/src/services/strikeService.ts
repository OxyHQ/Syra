import { descNullsLast } from '../db/catalog/containers';
import { and, count, eq } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { catalogEntities, catalogEntityStrikes, tracks } from '../db/schema/catalog';
import { logger } from '../utils/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of strikes that triggers permanent repeat-infringer termination. */
export const STRIKE_TERMINATION_THRESHOLD = 3;

/**
 * What a strike write did to the artist.
 *
 * Narrower than the whole artist row on purpose: both call sites read exactly
 * these two fields, and returning the row instead would put every artist column
 * — including the two `publicColumns()` protects — on a value a caller could
 * pass onward without noticing.
 */
export interface ArtistStrikeResult {
  /** Strikes the artist holds AFTER the write. */
  strikeCount: number;
  /** True once permanently terminated; never returns to false. */
  terminated: boolean;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return true when the given strike count meets or exceeds the termination
 * threshold, making the artist a DMCA repeat infringer.
 */
export function isRepeatInfringer(strikeCount: number): boolean {
  return strikeCount >= STRIKE_TERMINATION_THRESHOLD;
}

// ── Internals ─────────────────────────────────────────────────────────────────

/** The artist columns a strike write reads and decides on. */
interface StrikeSubject {
  id: string;
  terminated: boolean | null;
}

/**
 * Lock the artist row for the duration of the strike write.
 *
 * `for update` is not decoration. Both writes below are read-modify-write over
 * the same row (count the strikes, decide whether the count crossed the
 * threshold, write the decision back), and two concurrent strikes against one
 * artist — an ordinary shape for a batch takedown — could otherwise each see
 * two strikes and each write `strikeCount = 2` while three rows exist, so the
 * third strike would never terminate anybody. Mongo's read-modify-write had the
 * same race and no way to close it; this is one line.
 *
 * Returns null when no `type = 'artist'` row has that id. `type` is written out
 * because `catalog_entities` holds persons too, and Mongoose's discriminator
 * used to inject it invisibly.
 */
async function lockArtist(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  artistId: string
): Promise<StrikeSubject | null> {
  const [artist] = await tx
    .select({ id: catalogEntities.id, terminated: catalogEntities.terminated })
    .from(catalogEntities)
    .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
    .limit(1)
    .for('update');

  return artist ?? null;
}

/**
 * Strikes this artist currently holds, counted from the rows rather than read
 * off the stored counter.
 *
 * The Mongo version INCREMENTED `strikeCount` on add but RECOMPUTED it from
 * `strikes.length` on remove, so the two disagreed the moment the counter
 * drifted. Counting the child table in both directions makes the column a cache
 * of a fact the database can always re-derive.
 */
async function countStrikes(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  artistId: string
): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(catalogEntityStrikes)
    .where(eq(catalogEntityStrikes.catalogEntityId, artistId));

  return row?.total ?? 0;
}

/** The most recent remaining strike's timestamp, or null when none is left. */
async function latestStrikeAt(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  artistId: string
): Promise<Date | null> {
  const [row] = await tx
    .select({ createdAt: catalogEntityStrikes.createdAt })
    .from(catalogEntityStrikes)
    .where(eq(catalogEntityStrikes.catalogEntityId, artistId))
    .orderBy(descNullsLast(catalogEntityStrikes.createdAt))
    .limit(1);

  return row?.createdAt ?? null;
}

/**
 * Take down every track owned by the artist.
 *
 * Sets BOTH `copyrightRemoved` and `isAvailable:false`, matching the single-report
 * takedown in `copyright.controller`. `copyrightRemoved` alone is not enough: the
 * playback gate (`isTrackPlayable`) rejects on it, but the catalog filter keys off
 * `isAvailable`, so a track marked only `copyrightRemoved` stayed listed and
 * searchable and then failed at play. Termination is irreversible (`removeStrike`
 * never undoes it), so nothing has to restore these fields.
 */
async function takeDownArtistTracks(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  artistId: string,
  reason: string
): Promise<void> {
  await tx
    .update(tracks)
    .set({
      copyrightRemoved: true,
      isAvailable: false,
      removedAt: new Date(),
      removedReason: reason,
    })
    .where(and(eq(tracks.artistId, artistId), eq(tracks.copyrightRemoved, false)));
}

/** The permanent termination fields, applied together. */
function terminationFields(): {
  terminated: true;
  terminatedAt: Date;
  terminationReason: string;
  uploadsDisabled: true;
} {
  return {
    terminated: true,
    terminatedAt: new Date(),
    terminationReason:
      `Repeat-infringer termination: ${STRIKE_TERMINATION_THRESHOLD} or more copyright strikes`,
    uploadsDisabled: true,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a copyright strike to an artist.
 *
 * When the artist's cumulative strike count reaches STRIKE_TERMINATION_THRESHOLD
 * the account is permanently terminated and all their tracks are taken down
 * (copyrightRemoved = true). Termination is irreversible via removeStrike.
 *
 * The strike row, the artist's counters and the bulk takedown all commit
 * TOGETHER. Under Mongo the artist was saved first and the takedown issued
 * afterwards, so a failure between the two left an artist marked terminated
 * whose catalogue was still playable — a state nothing detected and nothing
 * retried.
 */
export async function addStrike(
  artistId: string,
  reason: string,
  trackId?: string,
): Promise<ArtistStrikeResult | null> {
  try {
    return await getDb().transaction(async (tx) => {
      const artist = await lockArtist(tx, artistId);
      if (!artist) {
        logger.warn(`[StrikeService] Artist not found: ${artistId}`);
        return null;
      }

      await tx.insert(catalogEntityStrikes).values({
        catalogEntityId: artistId,
        reason,
        trackId: trackId ?? null,
      });

      const strikeCount = await countStrikes(tx, artistId);
      const alreadyTerminated = artist.terminated === true;

      if (isRepeatInfringer(strikeCount)) {
        if (!alreadyTerminated) {
          // First time crossing the threshold — apply permanent termination.
          const fields = terminationFields();
          await tx
            .update(catalogEntities)
            .set({ ...fields, strikeCount, lastStrikeAt: new Date() })
            .where(eq(catalogEntities.id, artistId));

          await takeDownArtistTracks(tx, artistId, fields.terminationReason);

          logger.info(
            `[StrikeService] Artist ${artistId} terminated as repeat infringer ` +
            `(${strikeCount} strikes)`,
          );
          return { strikeCount, terminated: true };
        }

        // Already terminated — just record the new strike and keep uploads shut.
        await tx
          .update(catalogEntities)
          .set({ strikeCount, lastStrikeAt: new Date(), uploadsDisabled: true })
          .where(eq(catalogEntities.id, artistId));

        logger.info(
          `[StrikeService] Added strike to artist ${artistId}. Total: ${strikeCount}`,
        );
        return { strikeCount, terminated: true };
      }

      // Below the threshold — uploads stay enabled, unless already terminated.
      await tx
        .update(catalogEntities)
        .set({
          strikeCount,
          lastStrikeAt: new Date(),
          ...(alreadyTerminated ? {} : { uploadsDisabled: false }),
        })
        .where(eq(catalogEntities.id, artistId));

      logger.info(
        `[StrikeService] Added strike to artist ${artistId}. Total: ${strikeCount}`,
      );
      return { strikeCount, terminated: alreadyTerminated };
    });
  } catch (error) {
    logger.error(`[StrikeService] Error adding strike to artist ${artistId}:`, error);
    throw error;
  }
}

/**
 * Remove a specific strike from an artist (admin function).
 *
 * Recalculates strikeCount and re-enables uploads if below threshold — UNLESS
 * the artist has already been terminated. Termination is permanent and cannot
 * be undone by removing strikes.
 */
export async function removeStrike(
  artistId: string,
  strikeId: string,
): Promise<ArtistStrikeResult | null> {
  try {
    return await getDb().transaction(async (tx) => {
      const artist = await lockArtist(tx, artistId);
      if (!artist) {
        logger.warn(`[StrikeService] Artist not found: ${artistId}`);
        return null;
      }

      // Scoped to this artist as well as the strike id: an id belonging to a
      // different artist must not be deletable through this artist's endpoint.
      await tx
        .delete(catalogEntityStrikes)
        .where(
          and(
            eq(catalogEntityStrikes.id, strikeId),
            eq(catalogEntityStrikes.catalogEntityId, artistId)
          )
        );

      const strikeCount = await countStrikes(tx, artistId);
      const terminated = artist.terminated === true;

      await tx
        .update(catalogEntities)
        .set({
          strikeCount,
          lastStrikeAt: await latestStrikeAt(tx, artistId),
          // Termination is permanent — never undo it via strike removal.
          ...(terminated ? {} : { uploadsDisabled: isRepeatInfringer(strikeCount) }),
        })
        .where(eq(catalogEntities.id, artistId));

      logger.info(
        `[StrikeService] Removed strike from artist ${artistId}. Total: ${strikeCount}`,
      );
      return { strikeCount, terminated };
    });
  } catch (error) {
    logger.error(`[StrikeService] Error removing strike from artist ${artistId}:`, error);
    throw error;
  }
}

/**
 * Check if an artist has permission to upload content.
 *
 * Returns false when the artist is terminated or has uploads disabled — and
 * also when no such artist exists, so an unknown id can never be uploaded to.
 */
export async function checkUploadPermission(artistId: string): Promise<boolean> {
  try {
    const [artist] = await getDb()
      .select({
        terminated: catalogEntities.terminated,
        uploadsDisabled: catalogEntities.uploadsDisabled,
      })
      .from(catalogEntities)
      .where(and(eq(catalogEntities.id, artistId), eq(catalogEntities.type, 'artist')))
      .limit(1);

    if (!artist) return false;
    if (artist.terminated === true) return false;
    if (artist.uploadsDisabled === true) return false;
    return true;
  } catch (error) {
    logger.error(
      `[StrikeService] Error checking upload permission for artist ${artistId}:`,
      error,
    );
    return false;
  }
}
