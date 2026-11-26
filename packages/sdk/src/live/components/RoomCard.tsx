import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import MaterialCommunityIcons from '../icons/MaterialCommunityIcons';
import { useAuth } from '@oxy.so/services/ui/client';
import { createTokenStyles } from '@oxy.so/bloom/theme';

import { useLiveConfig } from '../context/LiveConfigContext';
import { AnimatedPulse } from './AnimatedPulse';
import { useRoomUsers, getAvatarUrl } from '../hooks/useRoomUsers';
import { LIVE_COLOR, LIVE_FOREGROUND_COLOR } from '../colors';
import type { LiveTheme } from '../types';

// --- Utility helpers ---

function formatCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(num);
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** `Today` / `Tomorrow` / `Yesterday`, else a locale short date (year only when it differs). */
function formatDay(date: Date, now: Date): string {
  const dayDelta = Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
  if (dayDelta === 0) return 'Today';
  if (dayDelta === 1) return 'Tomorrow';
  if (dayDelta === -1) return 'Yesterday';

  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString(undefined, options);
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The when-label for a room that is NOT live: the start time for a scheduled room
 * (`Tomorrow 18:00`), the day + duration for an ended one (`Yesterday · 45 min`).
 * A live room never uses this — its lead metric is the listener count.
 */
function getScheduleLabel(room: RoomCardProps['room'], now: Date): string {
  if (room.status === 'scheduled' && room.scheduledStart) {
    const start = new Date(room.scheduledStart);
    return `${formatDay(start, now)} ${formatTime(start)}`;
  }
  if (room.status === 'ended' && room.endedAt) {
    const day = formatDay(new Date(room.endedAt), now);
    return room.startedAt ? `${day} · ${formatDuration(room.startedAt, room.endedAt)}` : day;
  }
  if (room.createdAt) {
    return formatDay(new Date(room.createdAt), now);
  }
  return '';
}

// --- Constants ---

const MAX_SPEAKER_AVATARS = 3;
const SPEAKER_AVATAR_SIZE = 44;
const ROW_AVATAR_SIZE = 40;
const BYLINE_AVATAR_SIZE = 20;
const ACTION_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 };

// --- Types ---

interface RoomCardProps {
  room: {
    id: string;
    title: string;
    status: 'scheduled' | 'live' | 'ended';
    type?: 'talk' | 'stage' | 'broadcast';
    topic?: string | null;
    participants?: string[];
    speakers?: string[];
    host: string;
    houseId?: string | null;
    scheduledStart?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    createdAt?: string;
    stats?: { peakListeners?: number; totalJoined?: number };
  };
  onPress?: () => void;
  variant?: 'default' | 'compact';
  house?: { name: string; avatarUrl?: string } | null;
  hostName?: string;
  hostAvatarUri?: string;
  onMenuPress?: () => void;
  onSave?: () => void;
  isSaved?: boolean;
  style?: StyleProp<ViewStyle>;
}

// --- Component ---

/**
 * A room in a list. The `default` variant renders ONE of two presentations,
 * selected by `room.status`, because a live room and a listing of one are
 * different objects:
 *
 * - **live** → a featured card: the LIVE chip + the listener count (the only
 *   number that matters while a room is on air), the speaker faces, the host,
 *   and an explicit Join CTA.
 * - **scheduled / ended** → a flush full-width row: host avatar, title + when,
 *   byline, and one subtle right-side action. No card chrome, no CTA — there is
 *   nothing to join yet (or ever again).
 *
 * At most ONE status chip is ever shown (a live room is not a scheduled one, and
 * the date already says "scheduled"); the room type carries no badge at all.
 *
 * The `compact` variant is the small fixed-width card used by post attachments
 * and the composer preview, and follows the same rules in miniature.
 */
export const RoomCard: React.FC<RoomCardProps> = ({
  room,
  onPress,
  variant = 'default',
  house,
  hostName: hostNameProp,
  hostAvatarUri: hostAvatarUriProp,
  onMenuPress,
  onSave,
  isSaved,
  style,
}) => {
  const styles = useStyles();
  const { useTheme, useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useLiveConfig();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const hostProfile = useUserById(room.host);

  const isLive = room.status === 'live';
  const isScheduled = room.status === 'scheduled';
  const isCompact = variant === 'compact';
  const isFeatured = isLive && !isCompact;

  // Resolve host display: an explicit prop wins, then the @handle, then the
  // canonical API-owned `name.displayName` from the Oxy user DTO (never a
  // recompute from name parts), then a not-yet-resolved userId fallback.
  const hostProfileName = hostProfile?.name;
  const hostName =
    hostNameProp ??
    (hostProfile?.username
      ? `@${hostProfile.username}`
      : (typeof hostProfileName === 'object' ? hostProfileName?.displayName : null) ||
        room.host?.slice(0, 10) ||
        'Unknown');
  const hostAvatarUri =
    hostAvatarUriProp ?? getAvatarUrl(hostProfile, oxyServices, getCachedFileDownloadUrlSync);

  // Speaker faces only earn their space on the featured (live) card.
  const speakerIds = useMemo(() => {
    if (!isFeatured) return [];
    const ids = room.speakers?.length ? room.speakers : [room.host];
    return ids.slice(0, MAX_SPEAKER_AVATARS);
  }, [isFeatured, room.speakers, room.host]);
  const hiddenSpeakerCount = Math.max(0, (room.speakers?.length ?? 0) - speakerIds.length);

  useRoomUsers(speakerIds);

  const listenerCount = room.participants?.length || room.stats?.totalJoined || 0;
  const scheduleLabel = isLive ? '' : getScheduleLabel(room, new Date());
  const byline = house ? `by ${hostName} · ${house.name}` : `by ${hostName}`;

  // --- Compact variant (post attachments, composer preview) ---
  // It lives inside HORIZONTAL carousels, where a percentage width has no parent
  // to resolve against — hence the intrinsic width, capped at the parent so a
  // constrained host box (the composer preview) can still shrink it. Hosts
  // override any of this through `style`, which wins over the card's own style.
  if (isCompact) {
    return (
      <TouchableOpacity
        style={[styles.compactCard, style]}
        onPress={onPress}
        activeOpacity={onPress ? 0.7 : 1}
        disabled={!onPress}
      >
        <View style={styles.fill}>
          {isLive && (
            <View style={styles.compactBadgeRow}>
              <LiveBadge />
            </View>
          )}
          <Text style={styles.compactTitle} numberOfLines={2}>
            {room.title}
          </Text>
        </View>
        <View style={styles.compactMeta}>
          <View style={styles.compactBylineRow}>
            <AvatarComponent size={14} source={hostAvatarUri} shape="squircle" />
            <Text style={styles.compactByline} numberOfLines={1}>
              {byline}
            </Text>
          </View>
          <Text style={styles.compactMetaText} numberOfLines={1}>
            {isLive ? `${formatCompact(listenerCount)} listening` : scheduleLabel}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  // --- Featured card: a LIVE room, with presence and an explicit CTA ---
  if (isFeatured) {
    return (
      <TouchableOpacity
        style={[styles.featuredCard, style]}
        onPress={onPress}
        activeOpacity={onPress ? 0.7 : 1}
        disabled={!onPress}
      >
        {/* Status + the only number that matters on air, then icon-only actions */}
        <View style={styles.featuredStatusRow}>
          <LiveBadge />
          {listenerCount > 0 && (
            <>
              <Text style={styles.metaText}>·</Text>
              <Text style={styles.listenerCount} numberOfLines={1}>
                {formatCompact(listenerCount)} listening
              </Text>
            </>
          )}
          <View style={styles.fill} />
          {onSave && (
            <SaveAction onSave={onSave} isSaved={isSaved} isScheduled={false} theme={theme} />
          )}
          {onMenuPress && <MenuAction onMenuPress={onMenuPress} theme={theme} />}
        </View>

        <Text style={styles.featuredTitle} numberOfLines={2}>
          {room.title}
        </Text>

        <SpeakerStack speakerIds={speakerIds} hiddenCount={hiddenSpeakerCount} />

        {/* Host — a room's primary identity — and the join affordance */}
        <View style={styles.featuredHostRow}>
          <AvatarComponent size={BYLINE_AVATAR_SIZE} source={hostAvatarUri} shape="squircle" />
          <Text style={styles.featuredByline} numberOfLines={1}>
            {byline}
          </Text>
          {onPress && (
            <TouchableOpacity
              style={styles.joinButton}
              onPress={onPress}
              accessibilityRole="button"
              accessibilityLabel="Join room"
            >
              <Text style={styles.joinLabel}>Join</Text>
            </TouchableOpacity>
          )}
        </View>
      </TouchableOpacity>
    );
  }

  // --- Compact row: a SCHEDULED or ENDED room, flush in the feed ---
  return (
    <TouchableOpacity
      style={[styles.listRow, style]}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      <AvatarComponent size={ROW_AVATAR_SIZE} source={hostAvatarUri} shape="squircle" />

      <View style={styles.listRowBody}>
        <View style={styles.listRowTitleLine}>
          <Text style={styles.listRowTitle} numberOfLines={1}>
            {room.title}
          </Text>
          {scheduleLabel !== '' && (
            <Text style={styles.listRowSchedule} numberOfLines={1}>
              · {scheduleLabel}
            </Text>
          )}
        </View>
        <Text style={styles.metaText} numberOfLines={1}>
          {byline}
        </Text>
      </View>

      {onSave && (
        <SaveAction onSave={onSave} isSaved={isSaved} isScheduled={isScheduled} theme={theme} />
      )}
      {onMenuPress && <MenuAction onMenuPress={onMenuPress} theme={theme} />}
    </TouchableOpacity>
  );
};

// --- Badges ---

// The LIVE badge is the one surface that must NOT theme with the host: it is the
// brand's "on air" signal, so its red comes from the shared live palette and its
// content sits on white regardless of light/dark mode.
function LiveBadge() {
  const styles = useStyles();
  return (
    <View style={styles.liveBadge}>
      <AnimatedPulse size={6} color={LIVE_FOREGROUND_COLOR} />
      <Text style={styles.liveBadgeLabel}>LIVE</Text>
    </View>
  );
}

// --- Actions (icon-only, like the surrounding feed) ---

/**
 * The saved-state toggle. On a SCHEDULED room, saving it is how you ask to be
 * pulled back when it starts, so the icon reads as a reminder bell; anywhere
 * else it is a bookmark.
 */
function SaveAction({
  onSave,
  isSaved,
  isScheduled,
  theme,
}: {
  onSave: () => void;
  isSaved?: boolean;
  isScheduled: boolean;
  theme: LiveTheme;
}) {
  const icon = isScheduled
    ? isSaved
      ? 'bell'
      : 'bell-outline'
    : isSaved
      ? 'bookmark'
      : 'bookmark-outline';

  return (
    <TouchableOpacity
      onPress={onSave}
      hitSlop={ACTION_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={isScheduled ? 'Remind me about this room' : 'Save room'}
      accessibilityState={{ selected: Boolean(isSaved) }}
    >
      <MaterialCommunityIcons
        name={icon}
        size={20}
        color={isSaved ? theme.colors.primary : theme.colors.textSecondary}
      />
    </TouchableOpacity>
  );
}

function MenuAction({ onMenuPress, theme }: { onMenuPress: () => void; theme: LiveTheme }) {
  return (
    <TouchableOpacity
      onPress={onMenuPress}
      hitSlop={ACTION_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel="Room options"
    >
      <MaterialCommunityIcons name="dots-horizontal" size={20} color={theme.colors.textSecondary} />
    </TouchableOpacity>
  );
}

// --- Speaker stack (featured card only) ---

function SpeakerStack({ speakerIds, hiddenCount }: { speakerIds: string[]; hiddenCount: number }) {
  const styles = useStyles();
  if (speakerIds.length === 0) return null;

  return (
    <View style={styles.speakerStack}>
      {speakerIds.map((id, index) => (
        <View key={id} style={index === 0 ? undefined : styles.speakerOverlap}>
          <SpeakerAvatar userId={id} />
        </View>
      ))}
      {hiddenCount > 0 && (
        <View style={[styles.speakerOverlap, styles.hiddenSpeakerCount]}>
          <Text style={styles.hiddenSpeakerCountLabel}>+{formatCompact(hiddenCount)}</Text>
        </View>
      )}
    </View>
  );
}

function SpeakerAvatar({ userId }: { userId: string }) {
  const styles = useStyles();
  const { useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useLiveConfig();
  const { oxyServices } = useAuth();
  const profile = useUserById(userId);
  const avatarUri = getAvatarUrl(profile, oxyServices, getCachedFileDownloadUrlSync);

  // The ring is the card's own surface color, so overlapping faces stay separable.
  return (
    <View style={styles.speakerRing}>
      <AvatarComponent size={SPEAKER_AVATAR_SIZE} source={avatarUri} shape="squircle" />
    </View>
  );
}

export default RoomCard;

const useStyles = createTokenStyles((t) => ({
  compactCard: {
    minHeight: 140,
    width: 200,
    maxWidth: '100%',
    justifyContent: 'space-between',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    padding: 12,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  compactBadgeRow: { marginBottom: 6, flexDirection: 'row' },
  compactTitle: { fontSize: 14, lineHeight: 18, fontWeight: 600, color: t.foreground },
  compactMeta: { marginTop: 8, gap: 4 },
  compactBylineRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  compactByline: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 11,
    color: t.mutedForeground,
  },
  compactMetaText: { fontSize: 11, color: t.mutedForeground },
  featuredCard: {
    marginBottom: 12,
    width: '100%',
    gap: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    padding: 12,
  },
  featuredStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: 13, color: t.mutedForeground },
  listenerCount: { fontSize: 13, fontWeight: 600, color: t.mutedForeground },
  featuredTitle: { fontSize: 17, lineHeight: 22, fontWeight: 700, color: t.foreground },
  featuredHostRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  featuredByline: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 13,
    color: t.mutedForeground,
  },
  joinButton: {
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: LIVE_COLOR,
  },
  joinLabel: { fontSize: 13, fontWeight: 700, color: LIVE_FOREGROUND_COLOR },
  listRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  listRowBody: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', gap: 2 },
  listRowTitleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  listRowTitle: { flexShrink: 1, fontSize: 15, fontWeight: 600, color: t.foreground },
  listRowSchedule: { flexShrink: 0, fontSize: 13, color: t.mutedForeground },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: LIVE_COLOR,
  },
  liveBadgeLabel: { fontSize: 10, fontWeight: 700, color: LIVE_FOREGROUND_COLOR },
  speakerStack: { flexDirection: 'row', alignItems: 'center' },
  speakerOverlap: { marginLeft: -12 },
  hiddenSpeakerCount: {
    width: SPEAKER_AVATAR_SIZE,
    height: SPEAKER_AVATAR_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9999,
    borderWidth: 2,
    borderColor: t.surface,
    backgroundColor: t.muted,
  },
  hiddenSpeakerCountLabel: { fontSize: 13, fontWeight: 700, color: t.mutedForeground },
  speakerRing: { borderRadius: 9999, borderWidth: 2, borderColor: t.surface },
}));
