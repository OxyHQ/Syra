import { ArtistModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import { logger } from '../utils/logger';
import type { IArtist, IStrike } from '../models/CatalogEntity';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Number of strikes that triggers permanent repeat-infringer termination. */
export const STRIKE_TERMINATION_THRESHOLD = 3;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return true when the given strike count meets or exceeds the termination
 * threshold, making the artist a DMCA repeat infringer.
 */
export function isRepeatInfringer(strikeCount: number): boolean {
  return strikeCount >= STRIKE_TERMINATION_THRESHOLD;
}

// ── Internals ─────────────────────────────────────────────────────────────────

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
async function takeDownArtistTracks(artistId: string, reason: string): Promise<void> {
  await TrackModel.updateMany(
    { artistId, copyrightRemoved: { $ne: true } },
    {
      copyrightRemoved: true,
      isAvailable: false,
      removedAt: new Date(),
      removedReason: reason,
    },
  );
}

/** Apply permanent termination fields to the artist document. */
function applyTermination(artist: IArtist): void {
  artist.terminated = true;
  artist.terminatedAt = new Date();
  artist.terminationReason =
    `Repeat-infringer termination: ${STRIKE_TERMINATION_THRESHOLD} or more copyright strikes`;
  artist.uploadsDisabled = true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a copyright strike to an artist.
 *
 * When the artist's cumulative strike count reaches STRIKE_TERMINATION_THRESHOLD
 * the account is permanently terminated and all their tracks are taken down
 * (copyrightRemoved = true). Termination is irreversible via removeStrike.
 */
export async function addStrike(
  artistId: string,
  reason: string,
  trackId?: string,
): Promise<IArtist | null> {
  try {
    const artist = await ArtistModel.findById(artistId);
    if (!artist) {
      logger.warn(`[StrikeService] Artist not found: ${artistId}`);
      return null;
    }

    // Add strike to array
    const newStrike: IStrike = { reason, createdAt: new Date(), trackId };
    artist.strikes = artist.strikes ?? [];
    artist.strikes.push(newStrike);

    // Increment strike count
    artist.strikeCount = (artist.strikeCount ?? 0) + 1;
    artist.lastStrikeAt = new Date();

    // Termination takes priority over plain "disable uploads" path
    if (isRepeatInfringer(artist.strikeCount)) {
      if (!artist.terminated) {
        // First time crossing threshold — apply permanent termination
        applyTermination(artist);
        logger.info(
          `[StrikeService] Artist ${artistId} terminated as repeat infringer ` +
          `(${artist.strikeCount} strikes)`,
        );
        await artist.save();
        // Take down all tracks after saving artist state
        await takeDownArtistTracks(
          artistId,
          artist.terminationReason ?? 'repeat-infringer termination',
        );
        return artist.toObject() as IArtist;
      }
      // Already terminated — just persist the new strike record
      artist.uploadsDisabled = true;
    } else {
      // Below threshold — ensure uploads remain enabled (unless already terminated)
      if (!artist.terminated) {
        artist.uploadsDisabled = false;
      }
    }

    await artist.save();
    logger.info(
      `[StrikeService] Added strike to artist ${artistId}. Total: ${artist.strikeCount}`,
    );
    return artist.toObject() as IArtist;
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
): Promise<IArtist | null> {
  try {
    const artist = await ArtistModel.findById(artistId);
    if (!artist) {
      logger.warn(`[StrikeService] Artist not found: ${artistId}`);
      return null;
    }

    // Remove strike from array
    artist.strikes = (artist.strikes ?? []).filter(
      (strike) => strike._id?.toString() !== strikeId,
    );

    // Recalculate strike count
    artist.strikeCount = artist.strikes.length;

    // Update lastStrikeAt to most recent remaining strike
    if (artist.strikes.length > 0) {
      const sorted = [...artist.strikes].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      artist.lastStrikeAt = sorted[0]?.createdAt;
    } else {
      artist.lastStrikeAt = undefined;
    }

    // Termination is permanent — never undo it via strike removal
    if (!artist.terminated) {
      artist.uploadsDisabled = isRepeatInfringer(artist.strikeCount);
    }

    await artist.save();
    logger.info(
      `[StrikeService] Removed strike from artist ${artistId}. Total: ${artist.strikeCount}`,
    );
    return artist.toObject() as IArtist;
  } catch (error) {
    logger.error(`[StrikeService] Error removing strike from artist ${artistId}:`, error);
    throw error;
  }
}

/**
 * Check if an artist has permission to upload content.
 *
 * Returns false when the artist is terminated or has uploads disabled.
 */
export async function checkUploadPermission(artistId: string): Promise<boolean> {
  try {
    const artist = await ArtistModel.findById(artistId).lean();
    if (!artist) {
      return false;
    }
    if (artist.terminated) {
      return false;
    }
    if (artist.uploadsDisabled) {
      return false;
    }
    return true;
  } catch (error) {
    logger.error(
      `[StrikeService] Error checking upload permission for artist ${artistId}:`,
      error,
    );
    return false;
  }
}
