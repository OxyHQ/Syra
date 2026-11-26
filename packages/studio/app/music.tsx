import { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter, type Href } from 'expo-router';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Button } from '@oxy.so/bloom/button';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import type { Artist } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { useMyArtistProfile, useArtistDashboard } from '@/hooks/useArtist';
import { resolveCatalogImageUrl } from '@/utils/catalogImages';
import { createTokenStyles, tokenAlpha } from '@oxy.so/bloom/theme';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

function ArtistAvatar({ artist, size = 56 }: { artist: Artist; size?: number }) {
  const styles = useStyles();
  const theme = useTheme();
  const uri = resolveCatalogImageUrl(artist.image);
  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="cover"
        transition={150}
      />
    );
  }
  return (
    <View style={[styles.centered, { width: size, height: size }]}>
      <MaterialCommunityIcons name="account-music" size={size * 0.5} color={theme.colors.primary} />
    </View>
  );
}

function StatTile({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <View style={styles.surface}>
      <MaterialCommunityIcons name={icon} size={20} color={theme.colors.primary} />
      <Text style={styles.title}>{value}</Text>
      <Text style={styles.mutedText}>{label}</Text>
    </View>
  );
}

function ActionCard({
  icon,
  label,
  hint,
  onPress,
}: {
  icon: IconName;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 active:opacity-80"
    >
      <View style={styles.centered2}>
        <MaterialCommunityIcons name={icon} size={22} color={theme.colors.primary} />
      </View>
      <View style={styles.fill}>
        <Text style={styles.title2}>{label}</Text>
        <Text style={styles.mutedText}>{hint}</Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.textSecondary} />
    </Pressable>
  );
}

function BecomeArtistEmptyState({ onRegister }: { onRegister: () => void }) {
  const styles = useStyles();
  const theme = useTheme();
  return (
    <ScreenContainer title="Music" subtitle="For artists">
      <View style={styles.centered3}>
        <View style={styles.centered4}>
          <MaterialCommunityIcons name="music" size={30} color={theme.colors.primary} />
        </View>
        <Text style={styles.title3}>Bring your music to Syra</Text>
        <Text style={styles.mutedText2}>
          Register as an artist to upload songs, organize them into albums, and see how listeners
          are finding your music.
        </Text>
        <Button onPress={onRegister} tone="accent" appearance="solid">
          Become an artist
        </Button>
      </View>
    </ScreenContainer>
  );
}

function StudioDashboard({ artist }: { artist: Artist }) {
  const styles = useStyles();
  const router = useRouter();
  const theme = useTheme();
  const { data: dashboard, isLoading, isError, refetch } = useArtistDashboard();

  const go = useCallback((href: Href) => router.push(href), [router]);

  const stat = (value: number | undefined): string =>
    value === undefined ? '—' : value.toLocaleString();

  return (
    <ScreenContainer
      title={artist.name}
      subtitle="Artist studio"
      actions={
        <Button
          size="sm"
          onPress={() => go('/music/upload')}
          icon={<MaterialCommunityIcons name="plus" size={18} color="#fff" />}
          tone="accent"
          appearance="solid"
        >
          Upload
        </Button>
      }
    >
      <View style={styles.row}>
        <ArtistAvatar artist={artist} />
        <View style={styles.fill}>
          <View style={styles.row2}>
            <Text numberOfLines={1} style={styles.title4}>
              {artist.name}
            </Text>
            {artist.verified ? (
              <MaterialCommunityIcons
                name="check-decagram"
                size={16}
                color={theme.colors.primary}
              />
            ) : null}
          </View>
          {artist.genres && artist.genres.length > 0 ? (
            <Text numberOfLines={1} style={styles.mutedText}>
              {artist.genres.join(' · ')}
            </Text>
          ) : null}
        </View>
      </View>

      {dashboard?.uploadsDisabled ? (
        <View style={styles.row3}>
          <MaterialCommunityIcons name="alert-circle" size={22} color={theme.colors.error} />
          <Text style={styles.text}>
            Uploads are disabled due to copyright strikes. Contact support for more information.
          </Text>
        </View>
      ) : null}

      <View style={styles.row4}>
        <StatTile icon="music-note" label="Tracks" value={stat(dashboard?.totalTracks)} />
        <StatTile icon="album" label="Albums" value={stat(dashboard?.totalAlbums)} />
      </View>
      <View style={styles.row5}>
        <StatTile icon="play-circle-outline" label="Plays" value={stat(dashboard?.totalPlays)} />
        <StatTile icon="heart-outline" label="Followers" value={stat(dashboard?.followers)} />
      </View>

      <View style={styles.stack}>
        <ActionCard
          icon="cloud-upload-outline"
          label="Upload song"
          hint="Add a track to your catalog"
          onPress={() => go('/music/upload')}
        />
        <ActionCard
          icon="album"
          label="Create album"
          hint="Group tracks into a release"
          onPress={() => go('/music/album/new')}
        />
        <ActionCard
          icon="chart-line"
          label="Insights"
          hint="Plays, listeners, and top tracks"
          onPress={() => go('/music/insights')}
        />
      </View>

      {isLoading ? (
        <View style={styles.container}>
          <Loading />
        </View>
      ) : isError ? (
        <View style={styles.container2}>
          <Text style={styles.text2}>Couldn&apos;t load your studio.</Text>
          <Button onPress={() => refetch()} tone="neutral" appearance="outline">
            Retry
          </Button>
        </View>
      ) : dashboard ? (
        <>
          <Text style={styles.title5}>Recent tracks</Text>
          {dashboard.recentTracks.length === 0 ? (
            <View style={styles.surface2}>
              <Text style={styles.mutedText3}>No tracks yet.</Text>
              <Button
                size="sm"
                onPress={() => go('/music/upload')}
                tone="neutral"
                appearance="outline"
              >
                Upload your first song
              </Button>
            </View>
          ) : (
            <View style={styles.stack}>
              {dashboard.recentTracks.map((track) => (
                <View key={track.id} style={styles.row6}>
                  <View style={styles.centered5}>
                    <MaterialCommunityIcons
                      name="music-note"
                      size={18}
                      color={theme.colors.primary}
                    />
                  </View>
                  <Text numberOfLines={1} style={styles.text3}>
                    {track.title}
                  </Text>
                  <Text style={styles.mutedText4}>{track.playCount.toLocaleString()} plays</Text>
                </View>
              ))}
            </View>
          )}

          <Text style={styles.title5}>Recent albums</Text>
          {dashboard.recentAlbums.length === 0 ? (
            <View style={styles.surface3}>
              <Text style={styles.mutedText3}>No albums yet.</Text>
              <Button
                size="sm"
                onPress={() => go('/music/album/new')}
                tone="neutral"
                appearance="outline"
              >
                Create an album
              </Button>
            </View>
          ) : (
            <View style={styles.stack2}>
              {dashboard.recentAlbums.map((album) => (
                <View key={album.id} style={styles.row6}>
                  <View style={styles.centered5}>
                    <MaterialCommunityIcons name="album" size={18} color={theme.colors.primary} />
                  </View>
                  <Text numberOfLines={1} style={styles.text3}>
                    {album.title}
                  </Text>
                  <Text style={styles.mutedText4}>
                    {album.totalTracks} {album.totalTracks === 1 ? 'track' : 'tracks'}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </>
      ) : null}
    </ScreenContainer>
  );
}

function MusicStudio() {
  const styles = useStyles();
  const router = useRouter();
  const { data: artist, isLoading } = useMyArtistProfile();

  if (isLoading) {
    return (
      <View style={styles.centered6}>
        <Loading />
      </View>
    );
  }

  if (!artist) {
    return <BecomeArtistEmptyState onRegister={() => router.push('/music/register')} />;
  }

  return <StudioDashboard artist={artist} />;
}

export default function MusicScreen() {
  return (
    <SignInGate>
      <MusicStudio />
    </SignInGate>
  );
}

const useStyles = createTokenStyles((t) => ({
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9999,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
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
  centered2: {
    height: 40,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  title2: { fontSize: 14, fontWeight: 600, color: t.foreground, lineHeight: 20 },
  centered3: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 64,
  },
  centered4: {
    marginBottom: 16,
    height: 64,
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  title3: { marginBottom: 4, fontSize: 18, fontWeight: 600, color: t.foreground, lineHeight: 28 },
  mutedText2: {
    marginBottom: 20,
    maxWidth: 360,
    textAlign: 'center',
    fontSize: 14,
    color: t.mutedForeground,
    lineHeight: 20,
  },
  row: { marginBottom: 24, flexDirection: 'row', alignItems: 'center', gap: 12 },
  row2: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title4: { fontSize: 16, fontWeight: 600, color: t.foreground, lineHeight: 24 },
  row3: {
    marginBottom: 16,
    flexDirection: 'row',
    gap: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: tokenAlpha(t.destructive, 0.4),
    backgroundColor: tokenAlpha(t.destructive, 0.1),
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  text: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    color: t.foreground,
    lineHeight: 20,
  },
  row4: { marginBottom: 12, flexDirection: 'row', gap: 12 },
  row5: { marginBottom: 24, flexDirection: 'row', gap: 12 },
  stack: { marginBottom: 24, gap: 8 },
  container: { alignItems: 'center', paddingVertical: 40 },
  container2: { alignItems: 'center', paddingHorizontal: 24, paddingVertical: 40 },
  text2: { marginBottom: 12, fontSize: 16, color: t.foreground, lineHeight: 24 },
  title5: { marginBottom: 12, fontSize: 16, fontWeight: 600, color: t.foreground, lineHeight: 24 },
  surface2: {
    marginBottom: 24,
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 32,
  },
  mutedText3: { marginBottom: 12, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  row6: {
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
  centered5: {
    height: 36,
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: tokenAlpha(t.primary, 0.1),
  },
  text3: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    fontWeight: 500,
    color: t.foreground,
    lineHeight: 20,
  },
  mutedText4: { fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  surface3: {
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 32,
  },
  stack2: { gap: 8 },
  centered6: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.background,
  },
}));
