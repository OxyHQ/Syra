import mongoose from 'mongoose';
import type { Album, ArtistOrigin, Playlist, SourceProvenance, Track } from '@syra/shared-types';
import { TrackModel } from '../../models/Track';
import { PlaylistTrackModel } from '../../models/PlaylistTrack';
import { ContributionAttestationModel } from '../../models/ContributionAttestation';
import type { IArtist } from '../../models/CatalogEntity';
import {
  formatTracksWithCoverArt,
  formatAlbumWithCoverArt,
  formatPlaylistsWithCoverArt,
} from '../../utils/musicHelpers';
import { withImageFirstSort } from '../../utils/imageFirstSort';
import { canViewPlaylist, playableTrackFilter, type ViewablePlaylistShape } from '../../utils/catalogVisibility';
import {
  findAlbumsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
} from '../../utils/playableContainers';

/**
 * Everything Syra knows about an artist, assembled for their profile page.
 *
 * Every section here is gated by the SAME playability rules the rest of the
 * catalog uses — `playableTrackFilter` for tracks, the `playableContainers`
 * helpers for albums, artists and playlists. A section that is empty after
 * filtering comes back empty, because the alternative is a profile that offers a
 * shelf of containers which open to nothing.
 *
 * **Credited on** could not exist before this work, and is not a nicety: `Track`
 * carried only `artistId` until `credits[]` landed, so a guest verse, a
 * production credit or a remix could not be expressed at all, let alone found.
 * `credits.nameKey` is indexed precisely so this is a lookup rather than a scan
 * of every track's credit array.
 *
 * Related artists are deliberately NOT here. They are already served by
 * `GET /api/artists/:id/related` (`recommendationService.getRelatedArtists`,
 * which reads the same `CatalogRelation` graph) and the profile screen already
 * renders them from that query — a second reader would be two authorities for one
 * shelf. What that path was missing is the playability gate, and it was fixed
 * there rather than worked around here.
 */

// Caps. A profile page renders shelves, not archives — and every cap here also
// bounds the work a single unauthenticated request can ask the database to do.
const DISCOGRAPHY_LIMIT = 100;
const CREDITED_ON_LIMIT = 50;
const PLAYLISTS_LIMIT = 24;
/**
 * How many of the artist's own tracks seed the "playlists featuring them" lookup.
 *
 * Not the same number as the tracks shown on the page: a playlist that includes
 * one deep cut still features the artist, so the seed set is deliberately wider
 * than the shelf. It stays bounded because the `$in` it feeds is the leading
 * predicate of the playlist query.
 */
const PLAYLIST_SEED_TRACKS = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ArtistDiscography {
  albums: Album[];
  singlesAndEps: Album[];
  compilations: Album[];
}

export interface CreditedTrack {
  track: Track;
  /** The roles this artist holds on that track — `producer`, `composer`, `remixer`, a guest `artist`. */
  roles: string[];
}

export interface ArtistProfileState {
  origin?: ArtistOrigin;
  /** Contributed and unclaimed — the client shows a claim call to action. */
  claimable: boolean;
  claimed: boolean;
  acceptsContributions: boolean;
  sources?: SourceProvenance[];
  /** Union of every field named in `sources[].fields` — "somebody else wrote this". */
  externallySourcedFields: string[];
  /** Ids within the profile's own track list that a third party published. */
  contributedTrackIds: string[];
}

export interface ArtistProfileSections {
  discography: ArtistDiscography;
  creditedOn: CreditedTrack[];
  playlists: Playlist[];
  profileState: ArtistProfileState;
}

/** The artist fields these sections read. A lean projection satisfies it. */
export type ArtistProfileSource = Pick<
  IArtist,
  'nameKey' | 'origin' | 'claimable' | 'claimedByOxyUserId' | 'ownerOxyUserId' | 'acceptsContributions' | 'sources'
> & { _id: mongoose.Types.ObjectId };

// ── Discography ───────────────────────────────────────────────────────────────

/**
 * The artist's own releases, split by the release-type enum already on the model.
 *
 * ONE aggregation, partitioned in memory rather than three queries: each of those
 * would re-run the same `$lookup`-backed playability pipeline over the artist's
 * albums, and the split is a display concern, not a different question.
 *
 * Albums with no playable track never appear — `findAlbumsWithPlayableTracks` also
 * honours the album's own `isAvailable`, so a creator can unpublish a container
 * while its tracks stay individually discoverable.
 */
export async function loadDiscography(artistId: string): Promise<ArtistDiscography> {
  const albums = await findAlbumsWithPlayableTracks({ artistId }, {
    sort: withImageFirstSort('album', { releaseDate: -1 }),
    limit: DISCOGRAPHY_LIMIT,
  });

  const discography: ArtistDiscography = { albums: [], singlesAndEps: [], compilations: [] };

  for (const album of albums) {
    const formatted = formatAlbumWithCoverArt(album);
    if (!formatted) continue;
    const type = (album as { type?: string }).type;
    if (type === 'single' || type === 'ep') discography.singlesAndEps.push(formatted);
    else if (type === 'compilation') discography.compilations.push(formatted);
    else discography.albums.push(formatted);
  }

  return discography;
}

// ── Credited on ───────────────────────────────────────────────────────────────

/**
 * Tracks this artist participated in without being the primary artist.
 *
 * Queried on `credits.nameKey` ALONE, which is the indexed field. The obvious
 * widening — `$or` with `credits.catalogEntityId` — would be a mistake that costs
 * nothing to write and everything to run: MongoDB can only serve an `$or` from
 * indexes when EVERY branch is indexed, so adding an unindexed branch turns this
 * into a collection scan of `tracks` on every profile view.
 *
 * The refinement happens in memory instead, over the small matched set: a credit
 * counts when it is explicitly linked to THIS artist, or when it links nowhere and
 * matches by name. A credit resolved to a DIFFERENT entity that happens to share a
 * name key is excluded — two people genuinely called the same thing are two
 * people, and attributing one's work to the other is the failure this guards.
 */
export async function loadCreditedOn(artist: ArtistProfileSource): Promise<CreditedTrack[]> {
  const nameKey = artist.nameKey;
  if (!nameKey) return [];

  const artistId = artist._id.toString();
  const tracks = await TrackModel.find(
    playableTrackFilter({
      'credits.nameKey': nameKey,
      // Their own releases are the discography above; this section is everything else.
      artistId: { $ne: artistId },
    }),
  )
    .sort({ popularity: -1, createdAt: -1 })
    .limit(CREDITED_ON_LIMIT)
    .lean();

  if (tracks.length === 0) return [];

  const rolesByTrackId = new Map<string, string[]>();
  const kept: typeof tracks = [];

  for (const track of tracks) {
    const roles = (track.credits ?? [])
      .filter((credit) =>
        credit.nameKey === nameKey &&
        (credit.catalogEntityId === undefined || credit.catalogEntityId === artistId),
      )
      .map((credit) => credit.role);

    if (roles.length === 0) continue; // every matching credit belongs to somebody else
    rolesByTrackId.set(track._id.toString(), [...new Set(roles)]);
    kept.push(track);
  }

  const formatted = await formatTracksWithCoverArt(kept);
  return formatted.map((track: Track) => ({
    track,
    roles: rolesByTrackId.get(track.id) ?? [],
  }));
}

// ── Playlists featuring the artist ────────────────────────────────────────────

/**
 * Playlists that include this artist and that THIS viewer may read.
 *
 * Readability is asked of `canViewPlaylist`, never re-derived: it is the single
 * predicate for the question, and a surface that approximated it with
 * `visibility: 'public'` would quietly hide a viewer's own collaborative playlist
 * — and would be the second place the rule lives.
 *
 * The seed is the artist's own playable track ids, so the `PlaylistTrack` query
 * runs against its indexed `trackId` and the playlist pipeline's leading `$match`
 * is a bounded `_id: { $in }` rather than the whole collection.
 */
export async function loadPlaylistsFeaturing(
  artistId: string,
  viewerOxyUserId?: string,
): Promise<Playlist[]> {
  const seedTracks = await TrackModel.find(playableTrackFilter({ artistId }))
    .select('_id')
    .limit(PLAYLIST_SEED_TRACKS)
    .lean();
  if (seedTracks.length === 0) return [];

  const playlistIds = await PlaylistTrackModel.distinct('playlistId', {
    trackId: { $in: seedTracks.map((track) => track._id.toString()) },
  });
  if (playlistIds.length === 0) return [];

  const playlists = await findPlaylistsWithPlayableTracks({ _id: { $in: playlistIds } }, {
    sort: { followers: -1, createdAt: -1 },
    limit: PLAYLISTS_LIMIT,
  });

  const visible = playlists.filter((playlist) =>
    canViewPlaylist(playlist as ViewablePlaylistShape, viewerOxyUserId),
  );

  return formatPlaylistsWithCoverArt(visible);
}

// ── Profile state ─────────────────────────────────────────────────────────────

/**
 * What the client needs to explain this page to the artist it belongs to.
 *
 * Three questions: may somebody claim this profile; which of these fields did
 * nobody here write; and which of these recordings did somebody else publish.
 * The last one is what makes the contribution panel comprehensible — without it a
 * claimed artist sees a discography containing tracks they never uploaded and no
 * indication of which ones those are.
 */
export async function loadProfileState(
  artist: ArtistProfileSource,
  trackIds: string[],
): Promise<ArtistProfileState> {
  const externallySourcedFields = [
    ...new Set((artist.sources ?? []).flatMap((source) => source.fields ?? [])),
  ];

  const attestations = trackIds.length > 0
    ? await ContributionAttestationModel.find({ trackId: { $in: trackIds } })
      .select('trackId')
      .lean()
    : [];

  return {
    origin: artist.origin,
    claimable: artist.claimable === true && !artist.claimedByOxyUserId && !artist.ownerOxyUserId,
    claimed: Boolean(artist.claimedByOxyUserId ?? artist.ownerOxyUserId),
    acceptsContributions: artist.acceptsContributions === true,
    sources: artist.sources,
    externallySourcedFields,
    contributedTrackIds: attestations.map((attestation) => attestation.trackId),
  };
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Load every extra section of an artist profile in parallel.
 *
 * `trackIds` are the ids the caller is already showing under `music.tracks`, so
 * the contributed-versus-own distinction is computed for exactly the tracks the
 * page renders rather than for a set the client never sees.
 */
export async function loadArtistProfileSections(
  artist: ArtistProfileSource,
  options: { trackIds: string[]; viewerOxyUserId?: string },
): Promise<ArtistProfileSections> {
  const artistId = artist._id.toString();

  const [discography, creditedOn, playlists, profileState] = await Promise.all([
    loadDiscography(artistId),
    loadCreditedOn(artist),
    loadPlaylistsFeaturing(artistId, options.viewerOxyUserId),
    loadProfileState(artist, options.trackIds),
  ]);

  return { discography, creditedOn, playlists, profileState };
}

