import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ArtistStats } from '@syra/shared-types';

/** Unknown is not zero. The timestamp proves a complete aggregation ran. */
export function MonthlyListeners({ stats }: { stats?: ArtistStats }) {
  const { t, i18n } = useTranslation();
  if (!stats?.monthlyListenersComputedAt || stats.monthlyListeners === undefined) return null;
  const count = stats.monthlyListeners;
  return (
    <View className="px-6 pt-4 pb-2">
      <Text selectable className="text-muted-foreground text-base" accessibilityHint={t('listener.monthlyHint')}>
        {t('listener.monthly', { count, formatted: new Intl.NumberFormat(i18n.language).format(count) })}
      </Text>
    </View>
  );
}
