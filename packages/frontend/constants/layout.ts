/**
 * Shared layout dimensions used across the app shell and screens.
 *
 * Single source of truth so screens that need to clear chrome (e.g. the
 * library FAB clearing the player bar) stay in sync with the layout itself
 * instead of re-guessing the value. Mirrors `TOP_BAR_HEIGHT` in
 * `components/TopBar.tsx`.
 */

/**
 * Height (px) of the bottom player bar. Built from its padding-based sizing
 * (4px progress + 16px top + 56px content + 16px bottom). On desktop it sits
 * in normal flow below the panels; on mobile it floats above the bottom nav.
 */
export const PLAYER_BAR_HEIGHT = 92;
