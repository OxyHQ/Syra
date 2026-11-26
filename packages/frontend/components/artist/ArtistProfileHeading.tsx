import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useWindowWidthClass } from '@oxy.so/bloom/hooks';
import type { ArtistStats } from '@syra/shared-types';
import { MonthlyListeners } from './MonthlyListeners';

/** Keep the name and its audience in one responsive hero, including linked people. */
export function ArtistProfileHeading({ name, stats }: { name: string; stats?: ArtistStats }) {
  const width = useWindowWidthClass(BREAKPOINTS);
  return (
    <View style={styles.stack}>
      <Text
        accessibilityRole="header"
        style={[
          styles.name,
          width >= LG ? styles.nameLarge : width >= SM ? styles.nameMedium : null,
        ]}
        numberOfLines={2}
      >
        {name}
      </Text>
      <MonthlyListeners stats={stats} />
    </View>
  );
}

// Tailwind's `sm` and `lg`, the widths the name's `text-6xl` and `text-8xl` started at.
const SM = 640;
const LG = 1024;
const BREAKPOINTS = [SM, LG];

const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: 8 },
  name: { fontSize: 36, lineHeight: 40, fontWeight: '900', color: '#fff' },
  nameMedium: { fontSize: 60, lineHeight: 60 },
  nameLarge: { fontSize: 96, lineHeight: 96 },
});
