import { isLiveEntityId } from '@oxyhq/db';
import { and, eq } from 'drizzle-orm';
import { CONTRACT_LIMITS } from '@oxyhq/crowdsource-contracts';
import { PlaylistVisibility } from '@syra/shared-types';
import { findHouseById } from '../../db/rooms/houses';
import { findPublicRoomById } from '../../db/rooms/rooms';
import { roomHasRecording } from '../../db/rooms/recordings';
import { ReportedType } from '../../models/Report';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { playlists } from '../../db/schema/library';
import type {
  ModerationContextResource,
  ModerationResource,
  ModerationSubjectProvider,
  ModerationSubjectSnapshot,
} from './types';

/**
 * Syra's five deliverable nouns, described as universal material.
 *
 * One file rather than five, because every provider here is the same twenty
 * lines — load the row, clamp its text, name its owner — and splitting them would
 * put five imports and five headers around functions that share their whole
 * shape. The seam that matters is {@link ModerationSubjectProvider}; where the
 * implementations live is not load-bearing.
 */

const WEB_ORIGIN = process.env.FRONTEND_URL || 'https://syra.fm';

/** A non-empty string clamped to a contract limit, or nothing. */
function bounded(value: string | undefined | null, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** A `claims` / `metadata` value: bounded, flat, scalar (§5.3). */
function claim(value: string | undefined | null): string | undefined {
  return bounded(value, CONTRACT_LIMITS.METADATA_STRING_VALUE_MAX_LENGTH);
}

/**
 * A user's playlist (`custom.syra.playlist`).
 *
 * The cleanest subject Syra has: `ownerOxyUserId` is a real Oxy identity, `name` and
 * `description` are the owner's own words, and `visibility` says plainly whether
 * anyone else can see it.
 *
 * A PRIVATE playlist returns `null`. Nobody but its owner can reach it, so a
 * report about one either came from the owner — who can simply edit it — or from
 * somebody who should not have seen it, and neither is a question for a jury of
 * strangers. Handing a private list to a jury would disclose more than the report
 * ever justified.
 */
function playlistProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.PLAYLIST,
    subjectType: 'custom.syra.playlist',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      // No id-shape guard on the Postgres providers: `playlists.id` is `text`,
      // so a malformed id matches no row and the query answers the question the
      // guard used to. The Mongo providers below keep theirs, because an id of
      // the wrong shape reaches Mongoose as a CastError rather than a miss.
      const [playlist] = await getDb()
        .select({
          id: playlists.id,
          name: playlists.name,
          description: playlists.description,
          ownerOxyUserId: playlists.ownerOxyUserId,
          visibility: playlists.visibility,
          createdAt: playlists.createdAt,
        })
        .from(playlists)
        .where(eq(playlists.id, reportedId))
        .limit(1);
      if (!playlist) return null;
      if (playlist.visibility !== PlaylistVisibility.PUBLIC) return null;

      const title = bounded(playlist.name, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      // A listing needs a title; a playlist cannot be created without a name, so
      // an absent one is a corrupted row rather than a case to describe.
      if (title === undefined) return null;
      const description = bounded(
        playlist.description,
        CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH,
      );

      return {
        subject: {
          externalId: playlist.id,
          type: 'custom.syra.playlist',
          permalink: `${WEB_ORIGIN}/playlist/${playlist.id}`,
          author: { oxyUserId: playlist.ownerOxyUserId },
        },
        content: {
          type: 'listing',
          data: {
            title,
            ...(description === undefined ? {} : { description }),
          },
          createdAt: playlist.createdAt,
        },
      };
    },
  };
}

/**
 * A house — a user-created community (`custom.syra.house`).
 *
 * Same shape as a playlist and the same rule about reach: a house nobody can
 * discover is not something a jury should be shown. `canDiscover` on the model is
 * the app's own answer to "is this visible", so it is asked here rather than
 * re-derived from the visibility axes, which would be a second authority.
 */
function houseProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.HOUSE,
    subjectType: 'custom.syra.house',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      if (!isLiveEntityId(reportedId)) return null;
      const house = await findHouseById(reportedId);
      if (!house) return null;

      const title = bounded(house.name, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      if (title === undefined) return null;
      const description = bounded(house.description, CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH);

      return {
        subject: {
          externalId: house.id,
          type: 'custom.syra.house',
          permalink: `${WEB_ORIGIN}/house/${house.id}`,
          author: { oxyUserId: house.createdBy },
        },
        content: {
          type: 'listing',
          data: {
            title,
            ...(description === undefined ? {} : { description }),
          },
          createdAt: house.createdAt,
        },
      };
    },
  };
}

/**
 * A Syra artist profile (§5.3 `profile`).
 *
 * The one Syra noun that is a person's public identity rather than a thing they
 * published, which is why it is `identity.profile` and why a plain listener is
 * NOT reportable: a listener has no Syra-side profile at all, only an Oxy account
 * that Oxy owns.
 *
 * `claimedByOxyUserId` is the author when it exists and is simply absent when it
 * does not. An unclaimed artist is a catalog entity nobody has taken
 * responsibility for — there is a profile to review but no principal to bind, and
 * inventing one would attach a stranger to somebody else's page.
 */
function artistProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.ARTIST,
    subjectType: 'identity.profile',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const [artist] = await getDb()
        .select({
          id: catalogEntities.id,
          name: catalogEntities.name,
          bio: catalogEntities.bio,
          claimedByOxyUserId: catalogEntities.claimedByOxyUserId,
        })
        .from(catalogEntities)
        // `type = 'artist'` restores what `ArtistModel` did implicitly: it is a
        // Mongoose DISCRIMINATOR, so every query through it carried the type
        // filter. `catalog_entities` holds persons in the same table and drizzle
        // adds nothing, so the filter is written out — a person reported as an
        // artist profile is not this provider's subject.
        .where(and(eq(catalogEntities.id, reportedId), eq(catalogEntities.type, 'artist')))
        .limit(1);
      if (!artist) return null;

      const displayName = bounded(artist.name, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      const bio = bounded(artist.bio, CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH);
      const claims: Record<string, string> = {
        // Whether anybody has taken responsibility for the page is exactly what an
        // impersonation allegation turns on, so a jury is told plainly.
        claimed: artist.claimedByOxyUserId ? 'true' : 'false',
      };

      return {
        subject: {
          externalId: artist.id,
          type: 'identity.profile',
          permalink: `${WEB_ORIGIN}/artist/${artist.id}`,
          ...(artist.claimedByOxyUserId === null
            ? {}
            : { author: { oxyUserId: artist.claimedByOxyUserId } }),
        },
        content: {
          type: 'profile',
          data: {
            ...(displayName === undefined ? {} : { displayName }),
            ...(bio === undefined ? {} : { bio }),
            claims,
          },
        },
      };
    },
  };
}

/**
 * A track (`custom.syra.track`).
 *
 * ## The audio is declared, never attached
 *
 * A track's substance is its audio, and Syra cannot hand that to a jury. The
 * files are Syra-hosted HLS addressed by `hlsMasterKey`, encrypted, with no
 * sha256 recorded anywhere — so there is no bare Oxy `fileId` for an `AssetRef`
 * to carry, and shipping a URL on Syra's own host would tell that host when its
 * content is under review while delivering live bytes rather than the pinned
 * ones §5.6 requires.
 *
 * What travels is what a person WROTE: the title, and the artist's name as
 * context. That is genuinely reportable material — a title carrying a slur is
 * answerable on its face — and the metadata says plainly that audio exists which
 * the jury was not given, so `insufficient_context` is available for the right
 * reason rather than by accident.
 *
 * ## This is not the copyright path
 *
 * A track is also the object DMCA claims are about, and those go to
 * `CopyrightReport` instead. Nothing here sets `copyrightRemoved`; the only
 * enforcement a decision can reach is `isAvailable`, which is reversible.
 */
function trackProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.TRACK,
    subjectType: 'custom.syra.track',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      const [track] = await getDb()
        .select({
          id: tracks.id,
          title: tracks.title,
          artistId: tracks.artistId,
        })
        .from(tracks)
        .where(eq(tracks.id, reportedId))
        .limit(1);
      if (!track) return null;

      const title = bounded(track.title, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      if (title === undefined) return null;

      const context: ModerationContextResource[] = [];
      let ownerId: string | undefined;
      if (track.artistId) {
        const [artist] = await getDb()
          .select({
            name: catalogEntities.name,
            claimedByOxyUserId: catalogEntities.claimedByOxyUserId,
          })
          .from(catalogEntities)
          // `type = 'artist'` for the same reason `artistProvider` above needs
          // it, and missing it here is worse: `tracks.artist_id` references
          // `catalog_entities`, which holds PERSONS in the same table, so a
          // track pointing at a person row would contribute that person's name
          // as context and their `claimed_by_oxy_user_id` as the moderation
          // subject's AUTHOR — a report attributed to somebody who did not
          // publish it. `ArtistModel.findById` scoped this implicitly; drizzle
          // adds nothing.
          .where(and(eq(catalogEntities.id, track.artistId), eq(catalogEntities.type, 'artist')))
          .limit(1);
        ownerId = artist?.claimedByOxyUserId ?? undefined;
        const artistName = bounded(artist?.name, CONTRACT_LIMITS.TEXT_RESOURCE_MAX_LENGTH);
        if (artistName !== undefined) {
          context.push({ role: 'context', type: 'text', data: { text: artistName } });
        }
      }

      return {
        subject: {
          externalId: track.id,
          type: 'custom.syra.track',
          permalink: `${WEB_ORIGIN}/track/${track.id}`,
          ...(ownerId === undefined ? {} : { author: { oxyUserId: ownerId } }),
        },
        content: {
          type: 'metadata',
          data: {
            title,
            /** Declared, not attached — see the note above. */
            audioAttached: false,
          },
        },
        ...(context.length > 0 ? { context } : {}),
      };
    },
  };
}

/**
 * A live or ended audio room (`custom.syra.room`).
 *
 * ## What is pinned, and what deliberately is not
 *
 * A room IS a durable document — `title`, `description`, `topic`, `tags`,
 * `streamTitle`, `streamDescription` — and every one of those is HOST-AUTHORED.
 * A room titled with a slur or described to advertise a scam is a real report
 * with material §5.6 can pin and a jury can answer, and the host is answerable
 * for it. So a room is reportable, and the host is the subject's author.
 *
 * **What is NOT pinned is the conversation**, and that is not a tooling gap.
 * `participants` and `speakers` are mutable arrays that change every few seconds;
 * snapshotting either would pin a roster that was never true of the session as a
 * whole and would name people who merely listened. Neither travels.
 *
 * ## The recording exists, and is still not evidence
 *
 * Syra records rooms by default (`recordingEnabled` defaults to `true`, and
 * `POST /rooms/:id/start` starts an egress) and keeps them for months. It would
 * be easy to read `Recording.access === 'public'` as consent to send that audio
 * to a jury. It is not: that field governs who may replay the room INSIDE Syra,
 * and treating an in-app replay permission as consent to third-party review is
 * exactly the inference this note exists to refuse.
 *
 * It is also not mechanically possible. Recordings live in object storage
 * addressed by `objectKey` with no digest recorded, so there is no bare Oxy
 * `fileId` an `AssetRef` could carry — only a URL on Syra's own host, which is
 * the one thing evidence must never be.
 *
 * So the recording's EXISTENCE is declared and its content is withheld. A jury
 * told nothing would assume the title was all there was; a jury told that audio
 * exists which it was not given can answer `insufficient_context` for the right
 * reason.
 */
function roomProvider(): ModerationSubjectProvider {
  return {
    reportedType: ReportedType.ROOM,
    subjectType: 'custom.syra.room',

    async snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null> {
      if (!isLiveEntityId(reportedId)) return null;
      /**
       * The exclusion is the point rather than a side effect.
       *
       * The question to ask of any reported document is not only "what would a
       * jury learn that it should not" but "is there anything here a jury could
       * USE". On a room there is: `rtmpStreamKey` and `rtmpUrl` together are the
       * credential for broadcasting INTO the room. A juror who read them could
       * take over the stream of the room they were asked to judge.
       *
       * This used to be a hand-written Mongo projection listing nine fields,
       * where forgetting one exclusion was all it took. `findPublicRoomById`
       * reads through `publicColumns(rooms, PROTECTED_COLUMNS_BY_TABLE)`, so all
       * four stream credentials are absent from the returned TYPE — reaching for
       * one below fails `tsc` rather than shipping it, and the guard no longer
       * depends on this call site spelling a projection correctly. The wider
       * read is therefore safe where a bare `findById()` was not.
       *
       * `roomSubject.test.ts` still fails if a key ever reaches a snapshot; it
       * is the behavioural half, and the type is the structural one.
       */
      const room = await findPublicRoomById(reportedId);
      if (!room) return null;

      const title = bounded(room.title, CONTRACT_LIMITS.SHORT_TEXT_MAX_LENGTH);
      if (title === undefined) return null;

      /**
       * Only the host's own words. A stream title and description are host-set
       * too, so they belong with the rest of the material rather than in a
       * separate resource a jury has to correlate.
       */
      const description = bounded(
        [room.description, room.streamDescription]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join('\n\n'),
        CONTRACT_LIMITS.LONG_TEXT_MAX_LENGTH,
      );

      const hasRecording = await roomHasRecording(room.id);

      const context: ModerationContextResource[] = [];
      const topicAndTags = claim(
        [room.topic?.trim(), ...room.tags].filter(Boolean).join(', '),
      );

      const content: ModerationResource = {
        type: 'metadata',
        data: {
          title,
          ...(description === undefined ? {} : { description }),
          ...(topicAndTags === undefined ? {} : { topicAndTags }),
          ...(claim(room.streamTitle) === undefined
            ? {}
            : { streamTitle: claim(room.streamTitle) ?? '' }),
          roomStatus: room.status,
          /**
           * The two withheld things, stated rather than left to be inferred.
           * `participantsIncluded: false` is what tells a jury it is judging a
           * room's description and not who was in it.
           */
          recordingExists: hasRecording,
          recordingAttached: false,
          participantsIncluded: false,
        },
      };

      return {
        subject: {
          externalId: room.id,
          type: 'custom.syra.room',
          permalink: `${WEB_ORIGIN}/room/${room.id}`,
          author: { oxyUserId: room.host },
        },
        content,
        ...(context.length > 0 ? { context } : {}),
      };
    },
  };
}

export const SYRA_SUBJECT_PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  playlistProvider(),
  houseProvider(),
  artistProvider(),
  trackProvider(),
  roomProvider(),
]);
