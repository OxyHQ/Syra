/**
 * PlayerStore Configuration
 * Centralized constants and configuration for the audio player store
 */

/**
 * Position update interval in milliseconds
 * How often the player position is updated in the UI
 */
export const POSITION_UPDATE_INTERVAL_MS = 100;

/**
 * Audio player update interval in milliseconds
 * How often expo-audio updates its internal state
 */
export const AUDIO_PLAYER_UPDATE_INTERVAL_MS = 100;

/**
 * Playback initialization delay in milliseconds
 * Time to wait after calling play() before checking playback status
 */
export const PLAYBACK_INIT_DELAY_MS = 500;

/**
 * Default volume level (0.0 to 1.0)
 */
export const DEFAULT_VOLUME = 1.0;

/**
 * Minimum volume level
 */
export const MIN_VOLUME = 0.0;

/**
 * Maximum volume level
 */
export const MAX_VOLUME = 1.0;

/**
 * Audio URL endpoint path pattern
 * Used to extract track ID from audio source URLs
 */
export const AUDIO_URL_PATTERN = /\/api\/audio\/([^\/]+)/;

/**
 * Pre-signed URL expiration time in seconds (1 hour)
 */
export const PRESIGNED_URL_EXPIRATION_SECONDS = 3600;





