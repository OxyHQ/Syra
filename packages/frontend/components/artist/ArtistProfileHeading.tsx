import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import type { ArtistStats } from '@syra/shared-types';
import { MonthlyListeners } from './MonthlyListeners';

/** Keep the name and its audience in one responsive hero, including linked people. */
export function ArtistProfileHeading({ name, stats }: { name: string; stats?: ArtistStats }) {
  return (
    <View style={styles.stack}>
      <Text
        accessibilityRole="header"
        className="text-white text-4xl sm:text-6xl lg:text-8xl font-black"
        numberOfLines={2}
      >
        {name}
      </Text>
      <MonthlyListeners stats={stats} />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: 8 },
});
