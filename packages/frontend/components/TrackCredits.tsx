import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Track } from '@syra/shared-types';

/** Preserve unfamiliar roles and unresolved names; never invent contributors. */
export function TrackCredits({ track }: { track: Track }) {
  const { t } = useTranslation();
  const router = useRouter();
  const credits = track.credits ?? [];
  return (
    <View className="gap-4 py-4">
      <Text className="text-xl font-semibold text-foreground">{t('listener.credits')}</Text>
      {credits.length === 0 ? <Text className="text-muted-foreground">{t('listener.noCredits')}</Text> : null}
      {credits.map((credit, index) => (
        <View key={`${credit.catalogEntityId ?? credit.nameKey}:${credit.role}:${index}`} className="gap-1">
          {credit.catalogEntityId ? (
            <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/p/[id]', params: { id: credit.catalogEntityId } })}>
              <Text className="text-primary text-base font-medium">{credit.name}</Text>
            </Pressable>
          ) : <Text selectable className="text-foreground text-base font-medium">{credit.name}</Text>}
          <Text selectable className="text-muted-foreground">{credit.role}</Text>
        </View>
      ))}
      {track.metadata?.copyright ? <Text selectable className="text-muted-foreground">{track.metadata.copyright}</Text> : null}
      {track.metadata?.publisher ? <Text selectable className="text-muted-foreground">{track.metadata.publisher}</Text> : null}
    </View>
  );
}
