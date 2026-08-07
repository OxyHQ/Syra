import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Album, ArtistOrigin, Playlist, SourceProvenance, Track } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import { findAttestationsByTrackIds } from '../../db/creators/attestations';
import { albums, trackCredits, tracks } from '../../db/schema/catalog';
import { playlistCollaborators, playlistTracks, playlists } from '../../db/schema/library';
import { canViewPlaylist, playableTrackFilter } from '../../db/catalog/visibility';
import {
  desc as descOrder,
  findAlbumsWithPlayableTracks,
  findPlaylistsWithPlayableTracks,
  imageFirst,
  descNullsLast,
} from '../../db/catalog/containers';
import { loadImageVariants, toAlbumDtos, toTrackDtos } from '../../db/catalog/hydrate';
import { toPlaylistDto } from '../../db/catalog/serialize';

/**
 * Everything Syra knows about an artist, assembled for their profile page.
 *
 * Every section here is gated by the SAME playability rules the rest of the
 * catalog uses — `playableTrackFilter` for tracks, the `db/catalog/containers`
 * helpers for albums and playlists. A section that is empty after filtering
 * comes back empty, because the alternative is a profile that offers a shelf of
 * containers which open to nothing.
 *
 * **Credited on** could not exist before this work, and is not a nicety: `Track`
 * carried only `artistId` until `credits[]` landed, so a guest verse, a
 * production credit or a remix could not be expressed at all, let alone found.
 * `track_credits.name_key` is indexed precisely so this is a lookup rather than a
 * scan of every track's credits.
 *
 * Related artists are deliberately NOT here. They are already served by
 * `GET /api/artists/:id/related` (`recommendationService.getRelatedArtists`,
 * which reads the same `CatalogRelation` graph) and the profile screen already
 * renders them from that query — a second reader would be two authorities for one
 * shelf.
 *
 * `contribution_attestations` belongs to the creators vertical (Task 13), which
 * has landed — it is Postgres, read here for a list of track ids and never
 * joined to a catalog table. The separate read is what the split needed and is
 * now simply what this function does; nothing forces it any more.
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
 * than the shelf. It stays bounded because the `IN (…)` it feeds is the leading
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

/**
 * The artist fields these sections read.
 *
 * Named explicitly rather than `Pick`ed off a model type. Every field but `id` is
 * optional, so a caller that failed to load `nameKey` still typechecks and
 * silently returns an empty "credited on" section — which is why the caller's
 * own read has to name them too.
 */
export interface ArtistProfileSource {
  id: string;
  nameKey?: string;
  origin?: ArtistOrigin;
  claimable?: boolean;
  claimedByOxyUserId?: string;
  ownerOxyUserId?: string;
  acceptsContributions?: boolean;
  sources?: SourceProvenance[];
}

// ── Discography ───────────────────────────────────────────────────────────────

/**
 * The artist's own releases, split by the release-type enum already on the model.
 *
 * ONE query, partitioned in memory rather than three: each of those would re-run
 * the same playability semi-join over the artist's albums, and the split is a
 * display concern, not a different question.
 *
 * Albums with no playable track never appear — `findAlbumsWithPlayableTracks` also
 * honours the album's own `isAvailable`, so a creator can unpublish a container
 * while its tracks stay individually discoverable.
 */
export async function loadDiscography(artistId: string): Promise<ArtistDiscography> {
  const rows = await findAlbumsWithPlayableTracks(eq(albums.artistId, artistId), {
    orderBy: [imageFirst(albums.coverArtId), descOrder(albums.releaseDate)],
    limit: DISCOGRAPHY_LIMIT,
  });

  const formatted = await toAlbumDtos(rows);
  const discography: ArtistDiscography = { albums: [], singlesAndEps: [], compilations: [] };

  for (const album of formatted) {
    if (album.type === 'single' || album.type === 'ep') discography.singlesAndEps.push(album);
    else if (album.type === 'compilation') discography.compilations.push(album);
    else discography.albums.push(album);
  }

  return discography;
}

// ── Credited on ───────────────────────────────────────────────────────────────

/**
 * Tracks this artist participated in without being the primary artist.
 *
 * A join on `track_credits.name_key`, which is the indexed column, rather than
 * the Mongo `$or` widening that would have turned this into a collection scan of
 * every track on every profile view.
 *
 * The Mongo version then refined in memory: a credit counted when it was
 * explicitly linked to THIS artist, or when it linked nowhere and matched by
 * name. `track_credits` has no `catalog_entity_id` column at all —
 * `schema/catalog.ts` dropped it across all four places it was declared because
 * NONE of them was ever written — so every credit is the "links nowhere" case
 * and the refinement has nothing left to distinguish. Behaviour is unchanged
 * because the field was always absent; what is gone is the code that checked for
 * a value nothing produced.
 */
export async function loadCreditedOn(artist: ArtistProfileSource): Promise<CreditedTrack[]> {
  const nameKey = artist.nameKey;
  if (!nameKey) return [];

  /**
   * The LIMIT bounds tracks, not credit rows — and that needs two queries.
   *
   * `credits.nameKey` is one-to-many: an artist credited as producer AND
   * composer on the same track yields two joined rows. `LIMIT 50` over the join
   * therefore returns fewer than 50 TRACKS, and how many fewer depends on how
   * many roles each one happens to carry. Mongo bounded 50 documents and folded
   * roles afterwards, so a single query with a limit is a silent behaviour
   * change: the shelf shrinks for exactly the artists with the richest credits.
   *
   * `selectDistinct` over the joined shape is not the fix either — distinct
   * applies to the whole projected row, and the rows differ by `role`.
   */
  const trackIdRows = await getDb()
    .selectDistinct({ id: tracks.id, popularity: tracks.popularity, createdAt: tracks.createdAt })
    .from(tracks)
    .innerJoin(trackCredits, eq(trackCredits.trackId, tracks.id))
    .where(
      and(
        eq(trackCredits.nameKey, nameKey),
        // Their own releases are the discography above; this section is everything else.
        ne(tracks.artistId, artist.id),
        playableTrackFilter()
      )
    )
    .orderBy(descNullsLast(tracks.popularity), descNullsLast(tracks.createdAt))
    .limit(CREDITED_ON_LIMIT);

  if (trackIdRows.length === 0) return [];

  const rows = await getDb()
    .select({ track: tracks, role: trackCredits.role })
    .from(tracks)
    .innerJoin(trackCredits, eq(trackCredits.trackId, tracks.id))
    .where(
      and(
        inArray(tracks.id, trackIdRows.map((row) => row.id)),
        eq(trackCredits.nameKey, nameKey)
      )
    )
    .orderBy(descNullsLast(tracks.popularity), descNullsLast(tracks.createdAt));

  // One track can carry several credits for one person (producer AND composer),
  // so the join multiplies rows and the roles are folded back per track.
  const rolesByTrackId = new Map<string, Set<string>>();
  const trackById = new Map<string, (typeof rows)[number]['track']>();
  for (const row of rows) {
    trackById.set(row.track.id, row.track);
    const roles = rolesByTrackId.get(row.track.id) ?? new Set<string>();
    roles.add(row.role);
    rolesByTrackId.set(row.track.id, roles);
  }

  const ordered = [...trackById.values()];
  const formatted = await toTrackDtos(ordered);

  return formatted.map((track) => ({
    track,
    roles: [...(rolesByTrackId.get(track.id) ?? [])],
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
 * The collaborators are loaded for exactly the candidate playlists, in ONE query.
 * Passing `undefined` instead would make the predicate fail closed on every
 * non-public playlist, which reads as "working" for a guest and silently hides a
 * signed-in viewer's own collaborations.
 */
export async function loadPlaylistsFeaturing(
  artistId: string,
  viewerOxyUserId?: string,
): Promise<Playlist[]> {
  const seedTracks = await getDb()
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.artistId, artistId), playableTrackFilter()))
    .limit(PLAYLIST_SEED_TRACKS);
  if (seedTracks.length === 0) return [];

  const playlistIdRows = await getDb()
    .selectDistinct({ playlistId: playlistTracks.playlistId })
    .from(playlistTracks)
    .where(inArray(playlistTracks.trackId, seedTracks.map((track) => track.id)));
  if (playlistIdRows.length === 0) return [];

  const candidateIds = playlistIdRows.map((row) => row.playlistId);
  const rows = await findPlaylistsWithPlayableTracks(inArray(playlists.id, candidateIds), {
    orderBy: [descOrder(playlists.followers), descOrder(playlists.createdAt)],
    limit: PLAYLISTS_LIMIT,
  });
  if (rows.length === 0) return [];

  const collaborators = await getDb()
    .select({
      playlistId: playlistCollaborators.playlistId,
      oxyUserId: playlistCollaborators.oxyUserId,
    })
    .from(playlistCollaborators)
    .where(inArray(playlistCollaborators.playlistId, rows.map((row) => row.id)));

  const collaboratorsByPlaylist = new Map<string, string[]>();
  for (const entry of collaborators) {
    const existing = collaboratorsByPlaylist.get(entry.playlistId) ?? [];
    existing.push(entry.oxyUserId);
    collaboratorsByPlaylist.set(entry.playlistId, existing);
  }

  const visible = rows.filter((playlist) =>
    canViewPlaylist(
      {
        visibility: playlist.visibility,
        ownerOxyUserId: playlist.ownerOxyUserId,
        collaboratorOxyUserIds: collaboratorsByPlaylist.get(playlist.id) ?? [],
      },
      viewerOxyUserId
    )
  );
  if (visible.length === 0) return [];

  const lookup = await loadImageVariants(
    visible.flatMap((playlist) => [
      playlist.coverArtId,
      playlist.coverArtSizesSmallId,
      playlist.coverArtSizesMediumId,
      playlist.coverArtSizesLargeId,
      playlist.coverArtSizesXlargeId,
      playlist.coverArtSizesXxlargeId,
      playlist.coverArtSizesOriginalId,
    ])
  );

  return visible.map((playlist) => toPlaylistDto(playlist, lookup));
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

  const contributedTrackIds = [...(await findAttestationsByTrackIds(trackIds)).keys()];

  return {
    origin: artist.origin,
    claimable: artist.claimable === true && !artist.claimedByOxyUserId && !artist.ownerOxyUserId,
    claimed: Boolean(artist.claimedByOxyUserId ?? artist.ownerOxyUserId),
    acceptsContributions: artist.acceptsContributions === true,
    sources: artist.sources,
    externallySourcedFields,
    contributedTrackIds,
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
  const [discography, creditedOn, featuring, profileState] = await Promise.all([
    loadDiscography(artist.id),
    loadCreditedOn(artist),
    loadPlaylistsFeaturing(artist.id, options.viewerOxyUserId),
    loadProfileState(artist, options.trackIds),
  ]);

  return { discography, creditedOn, playlists: featuring, profileState };
}
