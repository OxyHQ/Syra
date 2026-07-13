/**
 * Live-rooms brand colors.
 *
 * These are the ONLY colors the live UI is allowed to hardcode: they carry
 * meaning that must survive every host theme (the live-indicator red reads as
 * "on air" in light and dark mode alike, and the room-type accents distinguish
 * Stage from Broadcast at a glance). Everything else in the live components
 * comes from the host's design tokens — NativeWind classNames (`bg-background`,
 * `text-foreground`, `text-muted-foreground`, `border-border`, …) or, where a
 * prop needs a literal color value (vector icons), the host `useTheme()` from
 * `LiveConfig`.
 *
 * Consuming apps should import these instead of re-declaring the hex values.
 */

/** The live-indicator red: LIVE badges, recording state, destructive live actions. */
export const LIVE_COLOR = '#FF4458';

/** {@link LIVE_COLOR} at ~10% alpha, for tinted surfaces behind live-colored content. */
export const LIVE_TINT_COLOR = '#FF44581A';

/** Foreground color for content sitting on {@link LIVE_COLOR}. */
export const LIVE_FOREGROUND_COLOR = '#FFFFFF';

/** Room kinds that get a type badge. `talk` is the default kind and carries none. */
export type BadgedRoomType = 'stage' | 'broadcast';

export interface RoomTypeMeta {
  /** MaterialCommunityIcons glyph name. */
  icon: 'account-voice' | 'broadcast';
  label: string;
  /** Accent color for the badge icon + label. */
  color: string;
  /** The accent at ~12% alpha, for the badge surface. */
  tintColor: string;
}

export const ROOM_TYPE_META: Record<BadgedRoomType, RoomTypeMeta> = {
  stage: {
    icon: 'account-voice',
    label: 'Stage',
    color: '#3B82F6',
    tintColor: '#3B82F620',
  },
  broadcast: {
    icon: 'broadcast',
    label: 'Broadcast',
    color: '#FF6B35',
    tintColor: '#FF6B3520',
  },
};

/** Badge metadata for a room kind, or `null` when the kind carries no badge (`talk`/unset). */
export function getRoomTypeMeta(type: 'talk' | BadgedRoomType | undefined): RoomTypeMeta | null {
  if (type === 'stage' || type === 'broadcast') return ROOM_TYPE_META[type];
  return null;
}
