import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ArtistStats } from '@syra/shared-types';

/** Unknown is not zero. The timestamp proves a complete aggregation ran. */
export function MonthlyListeners({ stats }: { stats?: ArtistStats }) {
  const { t, i18n } = useTranslation();
  if (!stats?.monthlyListenersComputedAt || stats.monthlyListeners === undefined) return null;
  const count = stats.monthlyListeners;
  return (
    <Text selectable style={styles.listeners} accessibilityHint={t('listener.monthlyHint')}>
      {t('listener.monthly', {
        count,
        formatted: new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(count),
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  listeners: { fontSize: 16, lineHeight: 24, color: '#fff' },
});
