import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { normalizeNameKey, type Track } from '@syra/shared-types';
import { createTokenStyles } from '@oxy.so/bloom/theme';

/** Preserve unfamiliar roles and unresolved names; never invent contributors. */
export function TrackCredits({ track }: { track: Track }) {
  const styles = useStyles();
  const { t } = useTranslation();
  const router = useRouter();
  const credits = [...(track.credits ?? [])];
  const hasPrimaryCredit = credits.some(
    (credit) =>
      credit.role.trim().toLowerCase() === 'artist' &&
      (credit.catalogEntityId
        ? credit.catalogEntityId === track.artistId
        : normalizeNameKey(credit.name) === normalizeNameKey(track.artistName)),
  );
  if (track.artistName.trim() && !hasPrimaryCredit) {
    credits.unshift({
      name: track.artistName,
      nameKey: normalizeNameKey(track.artistName),
      role: 'artist',
      catalogEntityId: track.artistId || undefined,
    });
  }
  return (
    <View style={styles.stack}>
      <Text style={styles.title}>{t('listener.credits')}</Text>
      {credits.length === 0 ? (
        <Text style={styles.mutedText}>{t('listener.noCredits')}</Text>
      ) : null}
      {credits.map((credit, index) => (
        <View
          key={`${credit.catalogEntityId ?? credit.nameKey}:${credit.role}:${index}`}
          style={styles.stack2}
        >
          {credit.catalogEntityId ? (
            <Pressable
              accessibilityRole="link"
              onPress={() =>
                router.push({ pathname: '/p/[id]', params: { id: credit.catalogEntityId } })
              }
            >
              <Text style={styles.text}>{credit.name}</Text>
            </Pressable>
          ) : (
            <Text selectable style={styles.text2}>
              {credit.name}
            </Text>
          )}
          <Text selectable style={styles.mutedText}>
            {credit.role === 'artist' ? t('common.artist') : credit.role}
          </Text>
        </View>
      ))}
      {track.metadata?.copyright ? (
        <Text selectable style={styles.mutedText}>
          {track.metadata.copyright}
        </Text>
      ) : null}
      {track.metadata?.publisher ? (
        <Text selectable style={styles.mutedText}>
          {track.metadata.publisher}
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = createTokenStyles((t) => ({
  stack: { gap: 16, paddingVertical: 16 },
  title: { fontSize: 20, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText: { color: t.mutedForeground },
  stack2: { gap: 4 },
  text: { fontSize: 16, fontWeight: 500, color: t.primary, lineHeight: 24 },
  text2: { fontSize: 16, fontWeight: 500, color: t.foreground, lineHeight: 24 },
}));
