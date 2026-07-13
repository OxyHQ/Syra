import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleProp, ViewStyle } from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useAuth } from '@oxyhq/services';

import { useLiveConfig } from '../context/LiveConfigContext';
import { AnimatedPulse } from './AnimatedPulse';
import { useRoomUsers, getAvatarUrl } from '../hooks/useRoomUsers';
import { LIVE_COLOR, LIVE_FOREGROUND_COLOR, getRoomTypeMeta, type RoomTypeMeta } from '../colors';

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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function getTimeLabel(room: RoomCardProps['room']): string {
  if (room.status === 'ended' && room.startedAt && room.endedAt) {
    return `${formatDuration(room.startedAt, room.endedAt)}  ·  ${formatDate(room.endedAt)}`;
  }
  if (room.status === 'live' && room.startedAt) {
    return `Live  ·  Started ${formatDate(room.startedAt)}`;
  }
  if (room.status === 'scheduled' && room.scheduledStart) {
    return formatDate(room.scheduledStart);
  }
  if (room.createdAt) {
    return formatDate(room.createdAt);
  }
  return '';
}

// --- Constants ---

const MAX_SPEAKER_AVATARS = 4;
const SPEAKER_AVATAR_SIZE = 44;

// --- Types ---

interface RoomCardProps {
  room: {
    _id: string;
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
  const { useTheme, useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useLiveConfig();
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const hostProfile = useUserById(room.host);

  const isLive = room.status === 'live';
  const isScheduled = room.status === 'scheduled';
  const isCompact = variant === 'compact';

  // Resolve host display: an explicit prop wins, then the @handle, then the
  // canonical API-owned `name.displayName` from the Oxy user DTO (never a
  // recompute from name parts), then a not-yet-resolved userId fallback.
  const hostProfileName = hostProfile?.name;
  const hostName = hostNameProp
    ?? (hostProfile?.username
      ? `@${hostProfile.username}`
      : (typeof hostProfileName === 'object' ? hostProfileName?.displayName : null)
        || room.host?.slice(0, 10)
        || 'Unknown');
  const hostAvatarUri = hostAvatarUriProp ?? getAvatarUrl(hostProfile, oxyServices, getCachedFileDownloadUrlSync);

  // Resolve speaker avatars (default variant only)
  const speakerIds = useMemo(() => {
    if (isCompact) return [];
    const ids = room.speakers?.length ? room.speakers : [room.host];
    return ids.slice(0, MAX_SPEAKER_AVATARS);
  }, [room.speakers, room.host, isCompact]);

  useRoomUsers(speakerIds);

  const typeMeta = getRoomTypeMeta(room.type);
  const listenerCount = room.participants?.length || room.stats?.totalJoined || 0;
  const timeLabel = getTimeLabel(room);

  // --- Compact variant (post attachments, composer preview) ---
  // It lives inside HORIZONTAL carousels, where a percentage width has no parent
  // to resolve against — hence the intrinsic width, capped at the parent so a
  // constrained host box (the composer preview) can still shrink it. Hosts
  // override any of this through `style`, which wins over the className.
  if (isCompact) {
    return (
      <TouchableOpacity
        className="w-[200px] max-w-full min-h-[140px] justify-between rounded-2xl border border-border bg-surface p-3"
        style={style}
        onPress={onPress}
        activeOpacity={onPress ? 0.7 : 1}
        disabled={!onPress}
      >
        <View className="flex-1">
          {house && (
            <Text
              className="mb-1 text-[9px] font-bold tracking-[0.5px] text-muted-foreground"
              numberOfLines={1}
            >
              {house.name.toUpperCase()}
            </Text>
          )}
          <Text className="text-sm font-semibold leading-[18px] text-foreground" numberOfLines={2}>
            {room.title}
          </Text>
          {(isLive || isScheduled || typeMeta) && (
            <View className="mt-1 flex-row flex-wrap gap-1">
              {isLive && <LiveBadge />}
              {isScheduled && <ScheduledBadge iconSize={10} iconColor={theme.colors.textSecondary} />}
              {typeMeta && <TypeBadge meta={typeMeta} />}
            </View>
          )}
        </View>
        <View className="mt-2 flex-row items-center gap-1">
          <MaterialCommunityIcons name="account-group" size={14} color={theme.colors.textSecondary} />
          <Text className="text-[11px] text-muted-foreground">{listenerCount} listening</Text>
          <Text className="text-[10px] text-muted-foreground">•</Text>
          {hostAvatarUri && (
            <AvatarComponent size={14} source={hostAvatarUri} shape="squircle" style={{ marginRight: 2 }} />
          )}
          <Text className="flex-1 text-[11px] text-muted-foreground" numberOfLines={1}>
            {hostName}
          </Text>
        </View>
      </TouchableOpacity>
    );
  }

  // --- Default variant: a full-width, flush feed row (hairline divider, no card chrome) ---
  return (
    <TouchableOpacity
      className="w-full gap-2 border-b border-border px-3 py-3"
      style={style}
      onPress={onPress}
      activeOpacity={onPress ? 0.7 : 1}
      disabled={!onPress}
    >
      {/* Section 1: House header + menu */}
      {(house || onMenuPress) && (
        <View className="flex-row items-center gap-1.5">
          {house && (
            <>
              <MaterialCommunityIcons name="home" size={14} color={theme.colors.primary} />
              <Text
                className="text-[11px] font-bold tracking-[0.5px] text-muted-foreground"
                numberOfLines={1}
              >
                {house.name.toUpperCase()}
              </Text>
            </>
          )}
          <View className="flex-1" />
          {onMenuPress && (
            <TouchableOpacity onPress={onMenuPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <MaterialCommunityIcons name="dots-horizontal" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Section 2: Title + status badges */}
      <View>
        <Text className="text-[17px] font-bold leading-[22px] text-foreground" numberOfLines={2}>
          {room.title}
        </Text>
        {(isLive || isScheduled || typeMeta) && (
          <View className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
            {isLive && <LiveBadge />}
            {isScheduled && <ScheduledBadge iconColor={theme.colors.textSecondary} />}
            {typeMeta && <TypeBadge meta={typeMeta} />}
          </View>
        )}
      </View>

      {/* Section 3: Speaker avatars + listener count */}
      <SpeakerRow speakerIds={speakerIds} listenerCount={listenerCount} />

      {/* Section 4: Metadata + save */}
      {(timeLabel || onSave) && (
        <View className="flex-row items-center justify-between">
          {timeLabel ? (
            <Text className="text-[13px] text-muted-foreground">{timeLabel}</Text>
          ) : (
            <View />
          )}
          {onSave && (
            <TouchableOpacity
              className="flex-row items-center gap-1"
              onPress={onSave}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MaterialCommunityIcons
                name={isSaved ? 'bookmark' : 'bookmark-outline'}
                size={18}
                color={isSaved ? theme.colors.primary : theme.colors.textSecondary}
              />
              <Text
                className={
                  isSaved
                    ? 'text-[13px] font-medium text-primary'
                    : 'text-[13px] font-medium text-muted-foreground'
                }
              >
                Save
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
};

// --- Badges ---

// The LIVE badge is the one surface that must NOT theme with the host: it is the
// brand's "on air" signal, so its red comes from the shared live palette and its
// content sits on white regardless of light/dark mode.
function LiveBadge() {
  return (
    <View
      className="flex-row items-center gap-1 rounded-[4px] px-2 py-1"
      style={{ backgroundColor: LIVE_COLOR }}
    >
      <AnimatedPulse size={6} color={LIVE_FOREGROUND_COLOR} />
      <Text className="text-[10px] font-bold text-white">LIVE</Text>
    </View>
  );
}

function ScheduledBadge({ iconSize = 12, iconColor }: { iconSize?: number; iconColor: string }) {
  return (
    <View className="flex-row items-center gap-1 rounded-[4px] bg-muted px-2 py-1">
      <MaterialCommunityIcons name="calendar" size={iconSize} color={iconColor} />
      <Text className="text-[10px] font-bold text-muted-foreground">SCHEDULED</Text>
    </View>
  );
}

function TypeBadge({ meta }: { meta: RoomTypeMeta }) {
  return (
    <View
      className="flex-row items-center gap-0.5 rounded-[4px] px-1.5 py-0.5"
      style={{ backgroundColor: meta.tintColor }}
    >
      <MaterialCommunityIcons name={meta.icon} size={10} color={meta.color} />
      <Text className="text-[9px] font-bold" style={{ color: meta.color }}>
        {meta.label}
      </Text>
    </View>
  );
}

// --- Speaker row sub-component ---

function SpeakerRow({ speakerIds, listenerCount }: { speakerIds: string[]; listenerCount: number }) {
  return (
    <View className="flex-row items-center gap-2">
      {speakerIds.map((id) => (
        <SpeakerAvatar key={id} userId={id} />
      ))}
      {listenerCount > 0 && (
        <View
          className="items-center justify-center rounded-[14px] border-2 border-border bg-muted"
          style={{ width: SPEAKER_AVATAR_SIZE + 4, height: SPEAKER_AVATAR_SIZE + 4 }}
        >
          <Text className="text-sm font-bold text-muted-foreground">
            +{formatCompact(listenerCount)}
          </Text>
        </View>
      )}
    </View>
  );
}

function SpeakerAvatar({ userId }: { userId: string }) {
  const { useUserById, AvatarComponent, getCachedFileDownloadUrlSync } = useLiveConfig();
  const { oxyServices } = useAuth();
  const profile = useUserById(userId);
  const avatarUri = getAvatarUrl(profile, oxyServices, getCachedFileDownloadUrlSync);

  return (
    <View className="rounded-[14px] border-2 border-border p-0.5">
      <AvatarComponent size={SPEAKER_AVATAR_SIZE} source={avatarUri} shape="squircle" />
    </View>
  );
}

export default RoomCard;
