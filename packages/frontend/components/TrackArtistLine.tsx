/**
 * The artist line under a track title — every artist on the record, not one.
 *
 * ## Why nested `Text` and not a row of `Pressable`s
 *
 * The names have to WRAP and truncate as one sentence: "A, B, C" ellipsised at
 * the row's width, with the comma staying attached to the name before it. A
 * flex row of pressables lays each name out as its own box, so a long credit
 * truncates the wrong thing or overflows. Nested `<Text onPress>` is the one
 * shape that stays a single run of text and is still tappable per segment, on
 * native and on web.
 *
 * That also settles the nested-pressable question in a list row: a `Text`'s
 * `onPress` stops the touch reaching the row behind it, so tapping a name opens
 * the artist and tapping anywhere else still plays the track.
 */
import React, { Fragment } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { useRouter } from 'expo-router';
import type { Track } from '@syra/shared-types';
import { trackArtists } from '@/utils/trackArtists';

interface TrackArtistLineProps {
  track: Pick<Track, 'artistId' | 'artistName' | 'credits'>;
  style?: StyleProp<TextStyle>;
  /** Applied to the tappable names only, so a link can be marked as one. */
  linkStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
  /**
   * Whether a name opens its artist page. False where a tap already means
   * something else and a second target would be ambiguous.
   */
  linked?: boolean;
  /** Rendered when the track has no artist at all — a locker file, typically. */
  fallback?: string;
  className?: string;
}

export function TrackArtistLine({
  track,
  style,
  linkStyle,
  numberOfLines = 1,
  linked = true,
  fallback = '',
  className,
}: TrackArtistLineProps) {
  const router = useRouter();
  const artists = trackArtists(track);

  if (artists.length === 0) {
    return (
      <Text className={className} style={style} numberOfLines={numberOfLines}>
        {fallback}
      </Text>
    );
  }

  return (
    <Text className={className} style={style} numberOfLines={numberOfLines}>
      {artists.map((artist, index) => (
        // The id is absent for a credit that never resolved to a catalogue row,
        // and two guests can share a name on different tracks — neither is a key
        // on its own, and position within one line is stable.
        <Fragment key={`${artist.id ?? artist.name}-${index}`}>
          {index > 0 ? ', ' : null}
          {linked && artist.id ? (
            <Text
              style={linkStyle}
              accessibilityRole="link"
              onPress={() => router.push(`/p/${artist.id}`)}
            >
              {artist.name}
            </Text>
          ) : (
            artist.name
          )}
        </Fragment>
      ))}
    </Text>
  );
}
