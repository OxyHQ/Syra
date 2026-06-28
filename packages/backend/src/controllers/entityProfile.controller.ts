import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { EntityProfile, EntityMusic, EntityAppearsIn } from '@syra/shared-types';
import { CatalogEntityModel, PersonModel, type CatalogEntityType } from '../models/CatalogEntity';
import { PodcastModel } from '../models/Podcast';
import { EpisodeModel } from '../models/Episode';
import { TrackModel } from '../models/Track';
import {
  formatArtistWithImage,
  formatAlbumWithCoverArt,
  formatTracksWithCoverArt,
} from '../utils/musicHelpers';
import { withImageFirstSort } from '../utils/imageFirstSort';
import { isDatabaseConnected } from '../utils/database';
import { getParam } from '../utils/reqParams';
import {
  getRequestUserId,
  playableTrackFilter,
  resolveCatalogPlaybackOptions,
  type CatalogPlaybackOptions,
} from '../utils/catalogVisibility';
import { findAlbumsWithPlayableTracks } from '../utils/playableContainers';
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
 * The data-only shape `formatArtistWithImage` returns (the artist doc with
 * `_id`→`id` and `image` normalised to an `/api/images/:id` ref). Typed
 * structurally so we read only the profile fields the unified DTO needs.
 */
type FormattedArtistProfile = {
  id: string;
  name: string;
  image?: string;
  imageSizes?: EntityProfile['imageSizes'];
  primaryColor?: string;
  secondaryColor?: string;
  bio?: string;
  genres?: string[];
  verified?: boolean;
  stats?: EntityProfile['stats'];
  links?: EntityProfile['links'];
};

/** The display fields shared by the old artist screen — pulled from the (formatted) Artist doc. */
type ArtistDisplayFields = Pick<
  EntityProfile,
  'image' | 'imageSizes' | 'primaryColor' | 'secondaryColor' | 'bio' | 'genres' | 'verified' | 'stats' | 'links'
>;

function artistDisplayFields(formatted: FormattedArtistProfile | null): ArtistDisplayFields {
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
  };
}

/**
 * Artist music — tracks + albums, both filtered by the viewer's playback policy
 * (REUSE of the same helpers `/api/artists/:id/albums|tracks` compose). Empty
 * arrays when the artist has no playable catalog.
 */
async function loadArtistMusic(
  artistId: string,
  playbackOptions: CatalogPlaybackOptions,
): Promise<EntityMusic> {
  const [albums, tracks] = await Promise.all([
    findAlbumsWithPlayableTracks({ artistId }, playbackOptions, {
      sort: withImageFirstSort('album', { releaseDate: -1 }),
      limit: ARTIST_ALBUMS_LIMIT,
    }),
    TrackModel.find(playableTrackFilter({ artistId }, playbackOptions))
      .sort(withImageFirstSort('track', { popularity: -1, createdAt: -1 }))
      .limit(ARTIST_TRACKS_LIMIT)
      .lean(),
  ]);

  const formattedAlbums = albums.map((album) => formatAlbumWithCoverArt(album)).filter(Boolean);
  const formattedTracks = await formatTracksWithCoverArt(tracks);
  return { tracks: formattedTracks, albums: formattedAlbums };
}

/**
 * Podcast appearances for a person — shows + episodes crediting them, matched by
 * STRONG key (`linkedOxyUserId` → `href` → exact name). Episodes honour the same
 * public playability gate as search (`status:'ready'` AND Syra-hosted OR has an
 * enclosure), composed with `$and` so the credit `$elemMatch` is preserved.
 */
async function loadAppearsIn(person: PersonLike): Promise<EntityAppearsIn> {
  const creditMatch = strongKeyCreditMatch(person);
  const [podcasts, episodes] = await Promise.all([
    PodcastModel.find({ ...creditMatch, status: { $ne: 'removed' } })
      .sort({ popularity: -1, lastEpisodeAt: -1 })
      .limit(APPEARS_IN_CAP)
      .lean(),
    EpisodeModel.find({
      ...creditMatch,
      status: 'ready',
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

/** Build a `PersonLike` (the strong-key + enrichment shape) from a Person doc. */
function toPersonLike(person: {
  _id: mongoose.Types.ObjectId;
  name: string;
  img?: string;
  href?: string;
  linkedOxyUserId?: string;
  linkedArtistId?: mongoose.Types.ObjectId;
}): PersonLike {
  return {
    _id: person._id,
    name: person.name,
    img: person.img,
    href: person.href,
    linkedOxyUserId: person.linkedOxyUserId,
    linkedArtistId: person.linkedArtistId,
  };
}

/**
 * The lean shape of a base CatalogEntity read — the fields the unified resolver
 * needs across both discriminator types. Artist-only fields (genres/stats/…) are
 * read at runtime by `formatArtistWithImage`, which is untyped, so they are not
 * listed here.
 */
type CatalogEntityLean = {
  _id: mongoose.Types.ObjectId;
  type: CatalogEntityType;
  name: string;
  img?: string;
  href?: string;
  linkedOxyUserId?: string;
  linkedArtistId?: mongoose.Types.ObjectId;
};

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
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: 'Not found' });
    }

    const playbackOptions = await resolveCatalogPlaybackOptions(getRequestUserId(req as AuthRequest));

    const entity = await CatalogEntityModel.findById(id).lean<CatalogEntityLean>();
    if (!entity) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Artist entity → profile + music; attach a linked person's appearances.
    if (entity.type === 'artist') {
      const formatted = formatArtistWithImage(entity) as FormattedArtistProfile | null;
      const [music, linkedPerson] = await Promise.all([
        loadArtistMusic(id, playbackOptions),
        PersonModel.findOne({ linkedArtistId: entity._id }).lean<CatalogEntityLean>(),
      ]);

      const profile: EntityProfile = {
        id,
        kind: 'artist',
        name: formatted?.name ?? entity.name,
        ...artistDisplayFields(formatted),
        linkedOxyUserId: linkedPerson?.linkedOxyUserId,
        music,
        appearsIn: linkedPerson ? await loadAppearsIn(toPersonLike(linkedPerson)) : undefined,
      };
      return res.json({ data: profile });
    }

    // Person entity → enriched identity + appearances; attach a linked artist's music.
    const personLike = toPersonLike(entity);
    const [appearsIn, enriched, linkedArtist] = await Promise.all([
      loadAppearsIn(personLike),
      enrichPersons([personLike], makeOxyUsersFetcher(oxy)),
      entity.linkedArtistId
        ? CatalogEntityModel.findById(entity.linkedArtistId).lean<CatalogEntityLean>()
        : Promise.resolve(null),
    ]);
    const identity = enriched[0];

    let music: EntityMusic | undefined;
    let linkedArtistFields: ArtistDisplayFields = artistDisplayFields(null);
    if (linkedArtist) {
      const formattedLinked = formatArtistWithImage(linkedArtist) as FormattedArtistProfile | null;
      music = await loadArtistMusic(linkedArtist._id.toString(), playbackOptions);
      linkedArtistFields = artistDisplayFields(formattedLinked);
    }

    const profile: EntityProfile = {
      id,
      kind: 'person',
      name: identity?.displayName ?? identity?.name ?? entity.name,
      displayName: identity?.displayName,
      username: identity?.username,
      avatar: identity?.oxyAvatar,
      ...linkedArtistFields,
      linkedArtistId: entity.linkedArtistId ? entity.linkedArtistId.toString() : undefined,
      linkedOxyUserId: entity.linkedOxyUserId,
      music,
      appearsIn,
    };
    return res.json({ data: profile });
  } catch (error) {
    next(error);
  }
};
