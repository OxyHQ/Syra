/**
 * Who a track is BY — the whole credit, not just the row it hangs off.
 *
 * A track has one `artistId`: the entity that owns it, the one whose page it
 * appears on. Everyone else on the record is a row in `track_credits`, and
 * before this existed every screen rendered `artistName` alone — so a record by
 * two people showed one name, and the guest was invisible everywhere in the app.
 *
 * The list is the principal followed by the `artist`-role credits in their
 * stored order. Other roles (producer, composer, mixer) are deliberately NOT in
 * it: they belong on a credits screen, not on the line under a title. Reading
 * them out of the same array is what keeps a listing and a detail screen from
 * disagreeing about what a track's credits are.
 */
import type { Track } from '@syra/shared-types';

export interface TrackArtist {
  /**
   * Absent when the credit is a NAME we cannot resolve to a catalogue row — a
   * name off a file tag is not an identity claim. Such an artist renders, but
   * does not link anywhere.
   */
  id?: string;
  name: string;
}

/** The performing credit, principal first. */
export function trackArtists(track: Pick<Track, 'artistId' | 'artistName' | 'credits'>): TrackArtist[] {
  const artists: TrackArtist[] = [];
  const seen = new Set<string>();

  const add = (name: string, id?: string): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Lowercased name rather than `nameKey`: the principal has no `nameKey` to
    // compare against, and the backend already dropped the principal from the
    // credits it writes. This only catches a row written before that fix.
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    artists.push(id ? { id, name: trimmed } : { name: trimmed });
  };

  add(track.artistName, track.artistId);
  for (const credit of track.credits ?? []) {
    if (credit.role !== 'artist') continue;
    add(credit.name, credit.catalogEntityId);
  }

  return artists;
}

/**
 * The credit as one string, for the places that cannot render a list: the OS
 * media session, a document title, a share text, an accessibility label.
 */
export function trackArtistsText(
  track: Pick<Track, 'artistId' | 'artistName' | 'credits'>,
  fallback: string
): string {
  const names = trackArtists(track).map((artist) => artist.name);
  return names.length > 0 ? names.join(', ') : fallback;
}
