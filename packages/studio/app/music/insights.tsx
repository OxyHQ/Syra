import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { useArtistInsights } from '@/hooks/useArtist';
import type { InsightsPeriod } from '@/services/artistService';
import { cn } from '@/lib/utils';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const PERIODS: { value: InsightsPeriod; label: string }[] = [
  { value: '7days', label: '7 days' },
  { value: '30days', label: '30 days' },
  { value: 'alltime', label: 'All time' },
];

function formatCount(value: number): string {
  return value.toLocaleString();
}

function PeriodSelector({
  value,
  onChange,
}: {
  value: InsightsPeriod;
  onChange: (value: InsightsPeriod) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      {PERIODS.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            className={cn(
              'flex-1 rounded-xl border px-3 py-2.5 items-center',
              active ? 'border-primary bg-primary/10' : 'border-border bg-surface',
            )}
          >
            <Text
              className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  value: string;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.surface}>
      <MaterialCommunityIcons name={icon} size={22} color={theme.colors.primary} />
      <Text style={styles.title}>{value}</Text>
      <Text style={styles.mutedText}>{label}</Text>
    </View>
  );
}

function Insights() {
  const styles = useStyles();
  const router = useRouter();
  const [period, setPeriod] = useState<InsightsPeriod>('30days');
  const { data: insights, isLoading, isError, refetch } = useArtistInsights(period);

  return (
    <ScreenContainer
      title="Insights"
      subtitle="How listeners are finding your music"
      onBack={() => router.back()}
    >
      <PeriodSelector value={period} onChange={setPeriod} />

      {isLoading ? (
        <View style={styles.container}>
          <Loading />
        </View>
      ) : isError || !insights ? (
        <View style={styles.container2}>
          <Text style={styles.text}>Couldn&apos;t load your insights.</Text>
          <Button onPress={() => refetch()} tone="neutral" appearance="outline">
            Retry
          </Button>
        </View>
      ) : (
        <>
          <View style={styles.row2}>
            <StatCard
              icon="play-circle-outline"
              label="Total plays"
              value={formatCount(insights.totalPlays)}
            />
            <StatCard
              icon="account-outline"
              label="Monthly listeners"
              value={formatCount(insights.monthlyListeners)}
            />
          </View>
          <View style={styles.row3}>
            <StatCard
              icon="heart-outline"
              label="Followers"
              value={formatCount(insights.followers)}
            />
            <View style={styles.fill} />
          </View>

          <Text style={styles.title2}>Top tracks</Text>
          {insights.topTracks.length === 0 ? (
            <View style={styles.surface2}>
              <Text style={styles.mutedText2}>No plays yet in this period.</Text>
            </View>
          ) : (
            <View style={styles.stack}>
              {insights.topTracks.map((track, index) => (
                <View key={track.trackId} style={styles.row4}>
                  <Text style={styles.mutedText3}>{index + 1}</Text>
                  <Text numberOfLines={1} style={styles.text2}>
                    {track.title}
                  </Text>
                  <Text style={styles.mutedText2}>{formatCount(track.playCount)} plays</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </ScreenContainer>
  );
}

export default function InsightsScreen() {
  return (
    <SignInGate>
      <Insights />
    </SignInGate>
  );
}

const useStyles = createTokenStyles((t) => ({
  row: { marginBottom: 24, flexDirection: 'row', gap: 8 },
  surface: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  title: { marginTop: 8, fontSize: 24, fontWeight: 700, color: t.foreground, lineHeight: 32 },
  mutedText: { marginTop: 2, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  container: { alignItems: 'center', paddingVertical: 64 },
  container2: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 64 },
  text: { marginBottom: 12, fontSize: 16, color: t.foreground, lineHeight: 24 },
  row2: { marginBottom: 12, flexDirection: 'row', gap: 12 },
  row3: { marginBottom: 24, flexDirection: 'row', gap: 12 },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  title2: { marginBottom: 12, fontSize: 16, fontWeight: 600, color: t.foreground, lineHeight: 24 },
  surface2: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 32,
  },
  mutedText2: { fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  stack: { gap: 8 },
  row4: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  mutedText3: {
    width: 24,
    fontSize: 14,
    fontWeight: 700,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  text2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    fontWeight: 500,
    color: t.foreground,
    lineHeight: 20,
  },
}));
