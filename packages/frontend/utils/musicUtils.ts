/**
 * Music-related utility functions
 */

/**
 * Format duration in seconds to MM:SS format
 */
export const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Format total duration for albums/playlists (e.g., "1 hr 23 min 45 sec" or "45 min 12 sec")
 */
export const formatTotalDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hours > 0) {
    return `${hours} hr ${mins} min ${secs} sec`;
  }
  return `${mins} min ${secs} sec`;
};






