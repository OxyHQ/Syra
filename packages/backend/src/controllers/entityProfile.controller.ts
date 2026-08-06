import { Request, Response, NextFunction } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { isLiveEntityId } from '@oxyhq/db';
import { publicColumns } from '@oxyhq/db/assert';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type {
  Artist,
  EntityProfile,
  EntityMusic,
  EntityAppearsIn,
  SourceProvenance,
} from '@syra/shared-types';
import { getDb } from '../db/postgres';
import { albums, catalogEntities, catalogEntitySources, tracks } from '../db/schema/catalog';
import { PROTECTED_COLUMNS_BY_TABLE } from '../db/schema/protectedColumns';
import { playableTrackFilter } from '../db/catalog/visibility';
import { findAlbumsWithPlayableTracks, imageFirst } from '../db/catalog/containers';
import { loadImageVariants, toAlbumDtos, toTrackDtos } from '../db/catalog/hydrate';
import { toArtistDto, type PublicCatalogEntityRow } from '../db/catalog/serialize';
import { PodcastModel } from '../models/Podcast';
import { hiddenShowEpisodeFilter } from '../utils/podcastDiscovery';
import { EpisodeModel } from '../models/Episode';
import { isDatabaseConnected } from '../utils/database';
import { getParam } from '../utils/reqParams';
import { getRequestUserId } from '../utils/catalogVisibility';
import {
  loadArtistProfileSections,
  type ArtistProfileSource,
} from '../services/catalog/artistProfile';
import { serializePodcast, serializeEpisode } from '../services/podcasts/podcastSerializers';
import { loadShowArtworkByPodcastId } from '../services/podcasts/episodeShowArtwork';
import {
  enrichPersons,
  strongKeyCreditMatch,
  makeOxyUsersFetcher,
  type PersonLike,
} from '../services/podcasts/resolvePersons';
import { oxy } from '../oxyClient';

const ARTIST_ALBUMS_LIMIT = 100;
const ARTIST_TRACKS_LIMIT = 50;
const APPEARS_IN_CAP = 50;

/**
 * `FormattedArtistProfile` lived here — a hand-written structural type
 * re-declaring what `formatArtistWithImage` returned, which was `any`, so
 * nothing ever checked the declaration against the thing it described. It is
 * deleted: `toArtistDto` returns an `Artist`, and every field read below is now
 * checked against the DTO it comes from.
 *
 * `members` in particular reached the wire only because the Mongo formatter
 * SPREAD the document. `toArtistDto` is an allowlist, and it did not name
 * `members` — on a comment claiming the column had no reader anywhere, which
 * `schema/catalog.ts` had already corrected in two places without the claim
 * being grepped out of `serialize.ts`. This controller is the reader.
 */

/** The display fields shared by the old artist screen — pulled from the artist DTO. */
type ArtistDisplayFields = Pick<
  EntityProfile,
  | 'image' | 'imageSizes' | 'primaryColor' | 'secondaryColor' | 'bio' | 'genres'
  | 'verified' | 'stats' | 'links' | 'country' | 'imageLicence' | 'sortName'
  | 'disambiguation' | 'artistType' | 'activeFrom' | 'activeUntil' | 'aliases'
  | 'labels' | 'members'
>;

function artistDisplayFields(formatted: Artist | null): ArtistDisplayFields {
  return {
    image: formatted?.image,
    imageSizes: formatted?.imageSizes,
    primaryColor: formatted?.primaryColor,
    secondaryColor: formatted?.secondaryColor,
    bio: formatted?.bio,
    genres: formatted?.genres,
    verified: formatted?.verified,
    stats: formatted?.stats,
    links: formatted?.links,
    country: formatted?.country,
    /**
     * Shipped with the image it describes. CC BY-SA is satisfied by naming the
     * author and linking the licence WHERE THE PHOTO IS SHOWN, so this travelling
     * with the profile is what makes displaying a Commons photo lawful at all.
     */
    imageLicence: formatted?.imageLicence,
    sortName: formatted?.sortName,
    disambiguation: formatted?.disambiguation,
    artistType: formatted?.artistType,
    activeFrom: formatted?.activeFrom,
    activeUntil: formatted?.activeUntil,
    aliases: formatted?.aliases,
    labels: formatted?.labels,
    members: formatted?.members,
  };
}

/**
 * Artist music — tracks + albums, both filtered by the viewer's playback policy
 * (REUSE of the same helpers `/api/artists/:id/albums|tracks` compose). Empty
 * arrays when the artist has no playable catalog.
 */
async function loadArtistMusic(
  artistId: string,
): Promise<EntityMusic> {
  const [albumRows, trackRows] = await Promise.all([
    findAlbumsWithPlayableTracks(eq(albums.artistId, artistId), {
      orderBy: [imageFirst(albums.coverArtId), desc(albums.releaseDate)],
      limit: ARTIST_ALBUMS_LIMIT,
    }),
    getDb()
      .select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
      .from(tracks)
      .where(and(playableTrackFilter(), eq(tracks.artistId, artistId)))
      .orderBy(imageFirst(tracks.coverArtId), desc(tracks.popularity), desc(tracks.createdAt))
      .limit(ARTIST_TRACKS_LIMIT),
  ]);

  const [formattedAlbums, formattedTracks] = await Promise.all([
    toAlbumDtos(albumRows),
    toTrackDtos(trackRows),
  ]);
  return { tracks: formattedTracks, albums: formattedAlbums };
}

/**
 * The artist-only sections of a profile: discography split by release type, the
 * tracks they were credited on without being the primary artist, playlists that
 * include them, and the claim/provenance state.
 *
 * Loaded for BOTH artist branches — an artist id directly, and a person id that
 * links to one — because a profile shows the same shelves however it was
 * addressed. `trackIds` is the list already under `music.tracks`, so the
 * contributed-versus-own distinction is computed for exactly the tracks rendered.
 */
async function loadArtistSections(
  artist: ArtistProfileSource,
  music: EntityMusic,
  viewerOxyUserId?: string,
): Promise<Pick<EntityProfile, 'discography' | 'creditedOn' | 'playlists' | 'profileState'>> {
  return loadArtistProfileSections(artist, {
    trackIds: music.tracks.map((track) => track.id),
    viewerOxyUserId,
  });
}

/**
 * Adapt an entity row to the id-shaped source the profile sections take.
 *
 * 10b added this to move `_id` → `id` at one place instead of two, and predicted
 * it would disappear once 10c read `catalog_entities` through drizzle. It has
 * not, and the reason is `sources`: Mongo carried it as an embedded array on the
 * document, Postgres keeps it in `catalog_entity_sources`, so the caller loads
 * it and hands it in. `null` → `undefined` on every optional field for the same
 * reason `PreviewSourceRef` needs it — `ArtistProfileSource` declares them
 * `?:`, not nullable, and `loadProfileState` distinguishes `undefined` from a
 * value on three of them.
 */
function toArtistProfileSource(
  entity: PublicCatalogEntityRow,
  sources: SourceProvenance[],
): ArtistProfileSource {
  return {
    id: entity.id,
    nameKey: entity.nameKey ?? undefined,
    origin: entity.origin ?? undefined,
    claimable: entity.claimable ?? undefined,
    claimedByOxyUserId: entity.claimedByOxyUserId ?? undefined,
    ownerOxyUserId: entity.ownerOxyUserId ?? undefined,
    acceptsContributions: entity.acceptsContributions ?? undefined,
    sources,
  };
}

/**
 * `catalog_entity_sources` for one entity, in stored order.
 *
 * A child table since the port, so the provenance the profile shows is a second
 * read rather than a field on the document. Ordered by `position`, which is the
 * only thing that preserves the array order Mongo had.
 */
async function loadEntitySources(entityId: string): Promise<SourceProvenance[]> {
  const rows = await getDb()
    .select({
      provider: catalogEntitySources.provider,
      externalId: catalogEntitySources.externalId,
      importedAt: catalogEntitySources.importedAt,
      fields: catalogEntitySources.fields,
    })
    .from(catalogEntitySources)
    .where(eq(catalogEntitySources.catalogEntityId, entityId))
    .orderBy(asc(catalogEntitySources.position));

  return rows.map((row) => ({
    provider: row.provider,
    externalId: row.externalId,
    importedAt: row.importedAt.toISOString(),
    fields: row.fields,
  }));
}

/** Serialize one entity row, loading only the image assets it references. */
async function toArtistProfile(row: PublicCatalogEntityRow): Promise<Artist> {
  const lookup = await loadImageVariants([
    row.imageId,
    row.imageSizesSmallId,
    row.imageSizesMediumId,
    row.imageSizesLargeId,
    row.imageSizesXlargeId,
    row.imageSizesXxlargeId,
    row.imageSizesOriginalId,
  ]);
  return toArtistDto(row, lookup);
}

/** One entity by id, whatever its type — the unified resolver's single read. */
async function findEntity(id: string): Promise<PublicCatalogEntityRow | undefined> {
  const [row] = await getDb()
    .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);

  return row;
}

/**
 * Podcast appearances for a person — shows + episodes crediting them, matched by
 * STRONG key (`linkedOxyUserId` → `href` → exact name). Episodes honour the same
 * public playability gate as search (`status:'ready'` AND Syra-hosted OR has an
 * enclosure), composed with `$and` so the credit `$elemMatch` is preserved.
 */
async function loadAppearsIn(person: PersonLike): Promise<EntityAppearsIn> {
  const creditMatch = strongKeyCreditMatch(person);
  const hiddenShows = await hiddenShowEpisodeFilter();
  const [podcasts, episodes] = await Promise.all([
    PodcastModel.find({ ...creditMatch, status: { $ne: 'removed' } })
      .sort({ popularity: -1, lastEpisodeAt: -1 })
      .limit(APPEARS_IN_CAP)
      .lean(),
    EpisodeModel.find({
      ...creditMatch,
      status: 'ready',
      // Episodes of an unpublished or removed show drop out of credit listings with it.
      ...hiddenShows,
      $and: [{ $or: [{ source: 'syra' }, { enclosureUrl: { $exists: true, $nin: [null, ''] } }] }],
    })
      .sort({ pubDate: -1 })
      .limit(APPEARS_IN_CAP)
      .lean(),
  ]);

  // Episodes here span many shows: resolve their parent-show artwork in ONE
  // `$in` query so cover-less episodes inherit it without an N+1.
  const showArtwork = await loadShowArtworkByPodcastId(episodes);

  return {
    podcasts: podcasts.map(serializePodcast),
    episodes: episodes.map((episode) =>
      serializeEpisode(episode, showArtwork.get(episode.podcastId.toString())),
    ),
  };
}

/** Build a `PersonLike` (the strong-key + enrichment shape) from an entity row. */
function toPersonLike(person: PublicCatalogEntityRow): PersonLike {
  return {
    _id: person.id,
    name: person.name,
    img: person.img ?? undefined,
    href: person.href ?? undefined,
    linkedOxyUserId: person.linkedOxyUserId ?? undefined,
    linkedArtistId: person.linkedArtistId ?? undefined,
  };
}

/**
 * `CatalogEntityLean` lived here: a hand-written lean shape whose doc comment
 * said artist-only fields were "read at runtime by `formatArtistWithImage`,
 * which is untyped, so they are not listed here". That is exactly the hole the
 * port closes — `publicColumns(catalogEntities, …)` yields
 * {@link PublicCatalogEntityRow}, which names every column the row really has
 * and omits the two that must never ship, so nothing is read at runtime that the
 * type does not carry.
 */

/**
 * GET /api/p/:id — unified entity profile. ONE `catalogentities` lookup resolves
 * the id to an artist OR person (`kind = entity.type`): artists carry music + a
 * linked person's appearances; persons carry appearances + a linked artist's music.
 */
export const getEntityProfile = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isDatabaseConnected()) {
      return res.status(503).json({ error: 'Database not available' });
    }

    const id = getParam(req, 'id');
    if (!isLiveEntityId(id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const entity = await findEntity(id);
    if (!entity) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Artist entity → profile + music; attach a linked person's appearances.
    const viewerOxyUserId = getRequestUserId(req as AuthRequest);

    if (entity.type === 'artist') {
      const [formatted, music, linkedPerson, sources] = await Promise.all([
        toArtistProfile(entity),
        loadArtistMusic(id),
        // `type = 'person'` is stated, not implied. Mongoose's discriminator
        // injected it into `PersonModel.findOne`; one table with a `type`
        // column does not, and the column is nullable for artists — so an
        // unscoped read here could resolve a person link to a non-person row.
        getDb()
          .select(publicColumns(catalogEntities, PROTECTED_COLUMNS_BY_TABLE))
          .from(catalogEntities)
          .where(and(eq(catalogEntities.type, 'person'), eq(catalogEntities.linkedArtistId, id)))
          .limit(1),
        loadEntitySources(id),
      ]);

      const person = linkedPerson[0];
      const profile: EntityProfile = {
        id,
        kind: 'artist',
        name: formatted.name,
        ...artistDisplayFields(formatted),
        linkedOxyUserId: person?.linkedOxyUserId ?? undefined,
        music,
        appearsIn: person ? await loadAppearsIn(toPersonLike(person)) : undefined,
        ...await loadArtistSections(toArtistProfileSource(entity, sources), music, viewerOxyUserId),
      };
      return res.json({ data: profile });
    }

    // Person entity → enriched identity + appearances; attach a linked artist's music.
    const personLike = toPersonLike(entity);
    const [appearsIn, enriched, linkedArtist] = await Promise.all([
      loadAppearsIn(personLike),
      enrichPersons([personLike], makeOxyUsersFetcher(oxy)),
      entity.linkedArtistId ? findEntity(entity.linkedArtistId) : Promise.resolve(undefined),
    ]);
    const identity = enriched[0];

    let music: EntityMusic | undefined;
    let linkedArtistFields: ArtistDisplayFields = artistDisplayFields(null);
    // A person page that links to an artist shows the SAME shelves as that
    // artist's own page — the profile is the artist's however it was addressed.
    let artistSections: Awaited<ReturnType<typeof loadArtistSections>> | undefined;
    if (linkedArtist) {
      const [formattedLinked, linkedSources] = await Promise.all([
        toArtistProfile(linkedArtist),
        loadEntitySources(linkedArtist.id),
      ]);
      music = await loadArtistMusic(linkedArtist.id);
      linkedArtistFields = artistDisplayFields(formattedLinked);
      artistSections = await loadArtistSections(
        toArtistProfileSource(linkedArtist, linkedSources),
        music,
        viewerOxyUserId,
      );
    }

    const profile: EntityProfile = {
      id,
      kind: 'person',
      name: identity?.displayName ?? identity?.name ?? entity.name,
      displayName: identity?.displayName,
      username: identity?.username,
      avatar: identity?.oxyAvatar,
      ...linkedArtistFields,
      linkedArtistId: entity.linkedArtistId ?? undefined,
      linkedOxyUserId: entity.linkedOxyUserId ?? undefined,
      music,
      appearsIn,
      ...artistSections,
    };
    return res.json({ data: profile });
  } catch (error) {
    next(error);
  }
};
