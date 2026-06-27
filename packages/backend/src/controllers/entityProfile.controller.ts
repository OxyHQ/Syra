import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { EntityProfile, EntityMusic, EntityAppearsIn } from '@syra/shared-types';
import { ArtistModel } from '../models/Artist';
import { PersonModel } from '../models/Person';
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
  primaryColor?: string;
  bio?: string;
  links?: EntityProfile['links'];
};

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

  return {
    podcasts: podcasts.map(serializePodcast),
    episodes: episodes.map(serializeEpisode),
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
 * GET /api/p/:id — unified entity profile. Resolves the id against BOTH Artist
 * and Person and returns the merged music (artist) + podcast appearances (person).
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

    // 1) Artist by id first.
    const artist = await ArtistModel.findById(id).lean();
    if (artist) {
      const formatted = formatArtistWithImage(artist) as FormattedArtistProfile | null;
      const [music, linkedPerson] = await Promise.all([
        loadArtistMusic(id, playbackOptions),
        PersonModel.findOne({ linkedArtistId: artist._id }).lean(),
      ]);

      const profile: EntityProfile = {
        id,
        kind: 'artist',
        name: formatted?.name ?? artist.name,
        image: formatted?.image,
        primaryColor: formatted?.primaryColor,
        bio: formatted?.bio,
        links: formatted?.links,
        linkedOxyUserId: linkedPerson?.linkedOxyUserId,
        music,
        appearsIn: linkedPerson ? await loadAppearsIn(toPersonLike(linkedPerson)) : undefined,
      };
      return res.json({ data: profile });
    }

    // 2) Person by id.
    const person = await PersonModel.findById(id).lean();
    if (person) {
      const personLike = toPersonLike(person);
      const [appearsIn, enriched, linkedArtist] = await Promise.all([
        loadAppearsIn(personLike),
        enrichPersons([personLike], makeOxyUsersFetcher(oxy)),
        person.linkedArtistId ? ArtistModel.findById(person.linkedArtistId).lean() : Promise.resolve(null),
      ]);
      const identity = enriched[0];

      let music: EntityMusic | undefined;
      let artistImage: string | undefined;
      let artistColor: string | undefined;
      let artistBio: string | undefined;
      let artistLinks: EntityProfile['links'];
      if (linkedArtist) {
        const formattedLinked = formatArtistWithImage(linkedArtist) as FormattedArtistProfile | null;
        music = await loadArtistMusic(linkedArtist._id.toString(), playbackOptions);
        artistImage = formattedLinked?.image;
        artistColor = formattedLinked?.primaryColor;
        artistBio = formattedLinked?.bio;
        artistLinks = formattedLinked?.links;
      }

      const profile: EntityProfile = {
        id,
        kind: 'person',
        name: identity?.displayName ?? identity?.name ?? person.name,
        displayName: identity?.displayName,
        username: identity?.username,
        avatar: identity?.oxyAvatar,
        image: artistImage,
        primaryColor: artistColor,
        bio: artistBio,
        links: artistLinks,
        linkedArtistId: person.linkedArtistId ? person.linkedArtistId.toString() : undefined,
        linkedOxyUserId: person.linkedOxyUserId,
        music,
        appearsIn,
      };
      return res.json({ data: profile });
    }

    // 3) Neither.
    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    next(error);
  }
};
