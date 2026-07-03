import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Button } from '@oxyhq/bloom/button';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { useArtistInsights } from '@/hooks/useArtist';
import type { InsightsPeriod } from '@/services/artistService';
import { cn } from '@/lib/utils';

const PERIODS: { value: InsightsPeriod; label: string }[] = [
  { value: '7days', label: '7 days' },
  { value: '30days', label: '30 days' },
  { value: 'alltime', label: 'All time' },
];

function formatCount(value: number): string {
  return value.toLocaleString();
}

function PeriodSelector({ value, onChange }: { value: InsightsPeriod; onChange: (value: InsightsPeriod) => void }) {
  return (
    <View className="flex-row gap-2 mb-6">
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
            <Text className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StatCard({ icon, label, value }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; label: string; value: string }) {
  const theme = useTheme();
  return (
    <View className="flex-1 rounded-2xl border border-border bg-surface px-4 py-4">
      <MaterialCommunityIcons name={icon} size={22} color={theme.colors.primary} />
      <Text className="text-2xl font-bold text-foreground mt-2">{value}</Text>
      <Text className="text-xs text-muted-foreground mt-0.5">{label}</Text>
    </View>
  );
}

function Insights() {
  const router = useRouter();
  const [period, setPeriod] = useState<InsightsPeriod>('30days');
  const { data: insights, isLoading, isError, refetch } = useArtistInsights(period);

  return (
    <ScreenContainer title="Insights" subtitle="How listeners are finding your music" onBack={() => router.back()}>
      <PeriodSelector value={period} onChange={setPeriod} />

      {isLoading ? (
        <View className="py-16 items-center">
          <Loading />
        </View>
      ) : isError || !insights ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base text-foreground mb-3">Couldn&apos;t load your insights.</Text>
          <Button variant="secondary" onPress={() => refetch()}>Retry</Button>
        </View>
      ) : (
        <>
          <View className="flex-row gap-3 mb-3">
            <StatCard icon="play-circle-outline" label="Total plays" value={formatCount(insights.totalPlays)} />
            <StatCard icon="account-outline" label="Monthly listeners" value={formatCount(insights.monthlyListeners)} />
          </View>
          <View className="flex-row gap-3 mb-6">
            <StatCard icon="heart-outline" label="Followers" value={formatCount(insights.followers)} />
            <View className="flex-1" />
          </View>

          <Text className="text-base font-semibold text-foreground mb-3">Top tracks</Text>
          {insights.topTracks.length === 0 ? (
            <View className="rounded-2xl border border-border bg-surface px-4 py-8 items-center">
              <Text className="text-sm text-muted-foreground">No plays yet in this period.</Text>
            </View>
          ) : (
            <View className="gap-2">
              {insights.topTracks.map((track, index) => (
                <View
                  key={track.trackId}
                  className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3"
                >
                  <Text className="text-sm font-bold text-muted-foreground w-6">{index + 1}</Text>
                  <Text numberOfLines={1} className="text-sm font-medium text-foreground flex-1">
                    {track.title}
                  </Text>
                  <Text className="text-sm text-muted-foreground">{formatCount(track.playCount)} plays</Text>
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
