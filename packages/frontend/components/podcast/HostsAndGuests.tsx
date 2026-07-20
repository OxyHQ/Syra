import React from 'react';
import { StyleSheet, View, Text, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import type { ResolvedPerson } from '@syra/shared-types';
import Avatar from '@/components/Avatar';
import { resolveExternalImageUri } from '@/utils/pickImage';

interface HostsAndGuestsProps {
  persons: ResolvedPerson[];
  /** Section heading. Defaults to the translated "Hosts & Guests". */
  title?: string;
}

/**
 * Apple-style "Hosts & Guests" credits, shared by the podcast show + episode
 * detail screens (single source). Per resolved person:
 *  - Oxy-linked (`linkedOxyUserId` + `oxyAvatar` + `displayName`): the live Oxy
 *    avatar (resolved as an Oxy file id via Bloom `Avatar`) + display name.
 *  - RSS person (`img` + `name`): the external avatar (rendered directly) + name.
 *
 * Tap destination policy: Oxy-linked (`username`) → `/u/[username]`; else
 * artist-linked (`linkedArtistId`) → `/p/[id]`; else the person's own unified
 * profile → `/p/[personId]`. The Oxy-user link is gated on `username` being in
 * the payload (the `/u/[username]` route resolves by username, not by Oxy id).
 */
export const HostsAndGuests: React.FC<HostsAndGuestsProps> = ({ persons, title }) => {
  const { t } = useTranslation();
  const heading = title ?? t('podcast.hostsAndGuests');
  const theme = useTheme();
  const router = useRouter();

  if (!persons || persons.length === 0) {
    return null;
  }

  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>{heading}</Text>
      {persons.map((person, index) => {
        const isOxyLinked = Boolean(person.linkedOxyUserId);
        const label = person.displayName || person.name;
        const linkedArtistId = person.linkedArtistId;
        const profileUsername = person.username;
        const externalImg = resolveExternalImageUri(person.img);

        // Oxy user profile first (gated on a username), then the linked Syra
        // artist, then the person's own unified `/p/[personId]` profile.
        const onPress = profileUsername
          ? () => router.push({ pathname: '/u/[username]', params: { username: profileUsername } })
          : linkedArtistId
          ? () => router.push({ pathname: '/p/[id]', params: { id: linkedArtistId } })
          : person.personId
          ? () => router.push({ pathname: '/p/[id]', params: { id: person.personId } })
          : undefined;

        return (
          <Pressable
            key={person.personId || `${person.name}-${index}`}
            disabled={!onPress}
            onPress={onPress}
            style={styles.row}
            accessibilityRole={onPress ? 'link' : undefined}
          >
            {isOxyLinked && person.oxyAvatar ? (
              <Avatar source={person.oxyAvatar} variant="thumb" size={44} label={label} />
            ) : externalImg ? (
              <Image source={{ uri: externalImg }} style={styles.avatar} contentFit="cover" />
            ) : (
              <View style={[styles.avatarPlaceholder, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <Ionicons name="person" size={18} color={theme.colors.textSecondary} />
              </View>
            )}
            <View style={styles.info}>
              <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                {label}
              </Text>
              {person.role ? (
                <Text style={[styles.role, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                  {person.role}
                </Text>
              ) : null}
            </View>
            {onPress ? <Ionicons name="chevron-forward" size={16} color={theme.colors.textSecondary} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
  },
  role: {
    fontSize: 13,
  },
});
