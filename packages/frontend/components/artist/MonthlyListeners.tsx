import React from 'react';
import { Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ArtistStats } from '@syra/shared-types';

/** Unknown is not zero. The timestamp proves a complete aggregation ran. */
export function MonthlyListeners({ stats }: { stats?: ArtistStats }) {
  const { t, i18n } = useTranslation();
  if (!stats?.monthlyListenersComputedAt || stats.monthlyListeners === undefined) return null;
  const count = stats.monthlyListeners;
  return (
    <Text selectable className="text-white text-base leading-6" accessibilityHint={t('listener.monthlyHint')}>
      {t('listener.monthly', { count, formatted: new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(count) })}
    </Text>
  );
}
