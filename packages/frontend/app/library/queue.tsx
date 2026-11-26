import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueueStore } from '@/stores/queueStore';
import { usePlayerStore } from '@/stores/playerStore';
import { createTokenStyles } from '@oxy.so/bloom/theme';

export default function QueueScreen() {
  const styles = useStyles();
  const { t } = useTranslation();
  const {
    queue,
    error,
    moveOccurrence,
    removeOccurrence,
    clearQueue,
    shuffle,
    repeat,
    toggleShuffle,
    cycleRepeat,
  } = useQueueStore();
  const { playFromQueue, stop } = usePlayerStore();
  return (
    <ScrollView
      style={styles.surface}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: t('listener.queue') }} />
      <Text style={styles.title}>{t('listener.queue')}</Text>
      <Text style={styles.mutedText}>{queue?.context?.name ?? t('listener.savedQueue')}</Text>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: shuffle === 'on' }}
          onPress={toggleShuffle}
        >
          <Text style={styles.text}>
            {t('listener.shuffleQueue')} · {t(`listener.mode_${shuffle}`)}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={cycleRepeat}>
          <Text style={styles.text}>
            {t('listener.repeat')} · {t(`listener.mode_${repeat}`)}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void stop();
            void clearQueue();
          }}
        >
          <Text style={styles.text}>{t('listener.clearQueue')}</Text>
        </Pressable>
      </View>
      {error ? (
        <Text accessibilityRole="alert" selectable style={styles.text2}>
          {error}
        </Text>
      ) : null}
      {(queue?.tracks ?? []).map((track, index) => (
        <View key={`${track.kind}:${track.id}:${index}`} style={styles.row2}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: index === queue?.current }}
            style={styles.fill}
            onPress={() => void playFromQueue(index)}
          >
            <Text style={index === queue?.current ? styles.currentTitle : styles.queueTitle}>
              {index + 1}. {track.title}
            </Text>
            <Text style={styles.mutedText}>{track.artistName}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={t('listener.moveUp')}
            disabled={index === 0}
            style={styles.section}
            onPress={() => void moveOccurrence(index, index - 1)}
          >
            <Text style={styles.text}>↑</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={t('listener.moveDown')}
            disabled={index === (queue?.tracks.length ?? 0) - 1}
            style={styles.section}
            onPress={() => void moveOccurrence(index, index + 1)}
          >
            <Text style={styles.text}>↓</Text>
          </Pressable>
          {index !== queue?.current ? (
            <Pressable
              accessibilityLabel={t('listener.remove')}
              style={styles.section}
              onPress={() => void removeOccurrence(index)}
            >
              <Text style={styles.text}>×</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

const useStyles = createTokenStyles((t) => ({
  surface: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', backgroundColor: t.background },
  content: { gap: 16, padding: 24, paddingBottom: 144 },
  title: { fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText: { color: t.mutedForeground },
  currentTitle: { fontWeight: 600, color: t.primary },
  queueTitle: { color: t.foreground },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  text: { color: t.primary },
  text2: { color: t.destructive },
  row2: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: 1,
    borderColor: t.border,
    paddingVertical: 12,
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  section: { padding: 12 },
}));
