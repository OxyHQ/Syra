import { ArtistModel } from '../models/Artist';
import { logger } from '../utils/logger';

/**
 * Add a strike to an artist
 * @param artistId - Artist ID
 * @param reason - Reason for the strike
 * @param trackId - Optional track ID associated with the strike
 * @returns Updated artist or null if not found
 */
export async function addStrike(
  artistId: string,
  reason: string,
  trackId?: string
): Promise<any | null> {
  try {
    const artist = await ArtistModel.findById(artistId);
    if (!artist) {
      logger.warn(`[StrikeService] Artist not found: ${artistId}`);
      return null;
    }

    // Add strike to array
    const newStrike = {
      reason,
      createdAt: new Date(),
      trackId,
    };
    artist.strikes = artist.strikes || [];
    artist.strikes.push(newStrike as any);

    // Increment strike count
    artist.strikeCount = (artist.strikeCount || 0) + 1;
    artist.lastStrikeAt = new Date();

    // Disable uploads if strike count >= 3
    if (artist.strikeCount >= 3) {
      artist.uploadsDisabled = true;
      logger.info(`[StrikeService] Uploads disabled for artist ${artistId} due to ${artist.strikeCount} strikes`);
    }

    await artist.save();
    logger.info(`[StrikeService] Added strike to artist ${artistId}. Total strikes: ${artist.strikeCount}`);
    
    return artist.toObject();
  } catch (error) {
    logger.error(`[StrikeService] Error adding strike to artist ${artistId}:`, error);
    throw error;
  }
}

/**
 * Remove a strike from an artist (admin function)
 * @param artistId - Artist ID
 * @param strikeId - Strike ID to remove
 * @returns Updated artist or null if not found
 */
export async function removeStrike(
  artistId: string,
  strikeId: string
): Promise<any | null> {
  try {
    const artist = await ArtistModel.findById(artistId);
    if (!artist) {
      logger.warn(`[StrikeService] Artist not found: ${artistId}`);
      return null;
    }

    // Remove strike from array
    artist.strikes = (artist.strikes || []).filter(
      (strike: any) => strike._id?.toString() !== strikeId
    );

    // Recalculate strike count
    artist.strikeCount = artist.strikes.length;
    
    // Re-enable uploads if strike count < 3
    if (artist.strikeCount < 3) {
      artist.uploadsDisabled = false;
      logger.info(`[StrikeService] Uploads re-enabled for artist ${artistId} (strikes: ${artist.strikeCount})`);
    }

    // Update lastStrikeAt to most recent strike if any remain
    if (artist.strikes.length > 0) {
      const sortedStrikes = [...artist.strikes].sort(
        (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      artist.lastStrikeAt = sortedStrikes[0].createdAt;
    } else {
      artist.lastStrikeAt = undefined;
    }

    await artist.save();
    logger.info(`[StrikeService] Removed strike from artist ${artistId}. Total strikes: ${artist.strikeCount}`);
    
    return artist.toObject();
  } catch (error) {
    logger.error(`[StrikeService] Error removing strike from artist ${artistId}:`, error);
    throw error;
  }
}

/**
 * Check if an artist has permission to upload
 * @param artistId - Artist ID
 * @returns true if artist can upload, false otherwise
 */
export async function checkUploadPermission(artistId: string): Promise<boolean> {
  try {
    const artist = await ArtistModel.findById(artistId).lean();
    if (!artist) {
      return false;
    }

    // Check if uploads are disabled
    if (artist.uploadsDisabled) {
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[StrikeService] Error checking upload permission for artist ${artistId}:`, error);
    return false;
  }
}






