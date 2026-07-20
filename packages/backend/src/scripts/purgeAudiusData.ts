/**
 * One-shot production data purge: remove every Audius-sourced document left over
 * from the removed Audius integration.
 *
 * REVIEW BEFORE RUNNING. This deletes production catalog data and is NOT run as
 * part of any deploy. It is DRY-RUN by default and only mutates when passed
 * `--apply`:
 *
 *   bun run src/scripts/purgeAudiusData.ts              # report only, no writes
 *   bun run src/scripts/purgeAudiusData.ts --apply      # perform the purge
 *
 * Reads go through the native driver, not the Mongoose models, deliberately:
 * `'audius'` has been removed from the `CatalogSource` enum, so the schemas no
 * longer model the very value we need to match on.
 *
 * Order matters — tracks first, then the containers they orphan, then the join
 * rows and residual fields:
 *
 *   1. tracks              source:'audius'                        -> delete
 *   2. playlisttracks      rows pointing at deleted tracks        -> delete
 *   3. albums              source:'audius', or now trackless      -> delete
 *   4. catalogentities     source:'audius', or now trackless      -> delete
 *   5. playlists           source:'audius', or now empty          -> delete
 *   6. imageassets         provider:'audius'                      -> delete
 *   7. survivors           externalIds.audiusId, streamUrl        -> unset
 *   8. usermusicpreferences directAudiusStreaming                 -> unset
 *
 * SAFETY: a container CLAIMED BY A REAL USER (`ownerOxyUserId` set) is never
 * deleted, even when Audius-sourced — a creator who claimed an imported artist
 * or playlist owns it now. Those are reported instead so they can be reviewed by
 * hand.
 */
import mongoose from 'mongoose';
import { connectToDatabase } from '../utils/database';
import { logger } from '../utils/logger';

const AUDIUS = 'audius';

export interface PurgeCounts {
  tracks: number;
  playlistTracks: number;
  albums: number;
  artists: number;
  playlists: number;
  imageAssets: number;
  externalIdsUnset: number;
  preferencesUnset: number;
  claimedContainersKept: number;
}

function db(): mongoose.mongo.Db {
  const conn = mongoose.connection.db;
  if (!conn) {
    throw new Error('purgeAudiusData: no database connection');
  }
  return conn;
}

/** Count everything the purge WOULD touch, without writing. */
export async function reportAudiusFootprint(): Promise<PurgeCounts> {
  const d = db();

  const audiusTrackIds = (
    await d.collection('tracks').find({ source: AUDIUS }, { projection: { _id: 1 } }).toArray()
  ).map((doc) => doc._id);
  const audiusTrackIdStrings = audiusTrackIds.map((id) => id.toString());

  const [albums, artists, playlists, imageAssets, playlistTracks, externalIdsUnset, preferencesUnset] =
    await Promise.all([
      d.collection('albums').countDocuments({ source: AUDIUS, ownerOxyUserId: { $in: [null, ''] } }),
      d.collection('catalogentities').countDocuments({ source: AUDIUS, ownerOxyUserId: { $in: [null, ''] } }),
      d.collection('playlists').countDocuments({ source: AUDIUS, ownerOxyUserId: { $in: [null, '', 'system:audius'] } }),
      d.collection('imageassets').countDocuments({ provider: AUDIUS }),
      d.collection('playlisttracks').countDocuments({ trackId: { $in: audiusTrackIdStrings } }),
      d.collection('tracks').countDocuments({ 'externalIds.audiusId': { $exists: true }, source: { $ne: AUDIUS } }),
      d.collection('usermusicpreferences').countDocuments({ directAudiusStreaming: { $exists: true } }),
    ]);

  const claimedContainersKept =
    (await d.collection('albums').countDocuments({ source: AUDIUS, ownerOxyUserId: { $nin: [null, ''] } })) +
    (await d.collection('catalogentities').countDocuments({ source: AUDIUS, ownerOxyUserId: { $nin: [null, ''] } })) +
    (await d.collection('playlists').countDocuments({ source: AUDIUS, ownerOxyUserId: { $nin: [null, '', 'system:audius'] } }));

  return {
    tracks: audiusTrackIds.length,
    playlistTracks,
    albums,
    artists,
    playlists,
    imageAssets,
    externalIdsUnset,
    preferencesUnset,
    claimedContainersKept,
  };
}

/**
 * Delete containers of `collection` that reference no surviving track.
 * `relationField` is the string field on `tracks` pointing back at the container.
 */
async function deleteTracklessContainers(
  collection: 'albums' | 'catalogentities',
  relationField: 'albumId' | 'artistId',
): Promise<number> {
  const d = db();
  const survivingIds = new Set(
    (await d.collection('tracks').distinct(relationField, {})).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );

  const candidates = await d
    .collection(collection)
    .find({ ownerOxyUserId: { $in: [null, ''] } }, { projection: { _id: 1 } })
    .toArray();

  const orphaned = candidates
    .map((doc) => doc._id)
    .filter((id) => !survivingIds.has(id.toString()));

  if (orphaned.length === 0) return 0;
  const result = await d.collection(collection).deleteMany({ _id: { $in: orphaned } });
  return result.deletedCount ?? 0;
}

export async function purgeAudiusData(): Promise<PurgeCounts> {
  const d = db();

  const audiusTrackIds = (
    await d.collection('tracks').find({ source: AUDIUS }, { projection: { _id: 1 } }).toArray()
  ).map((doc) => doc._id);
  const audiusTrackIdStrings = audiusTrackIds.map((id) => id.toString());

  // 1 + 2. Tracks, and the playlist join rows that referenced them.
  const tracks = (await d.collection('tracks').deleteMany({ source: AUDIUS })).deletedCount ?? 0;
  const playlistTracks =
    (await d.collection('playlisttracks').deleteMany({ trackId: { $in: audiusTrackIdStrings } })).deletedCount ?? 0;

  // 3-5. Audius-sourced containers, then anything they left trackless.
  const albumsDirect =
    (await d.collection('albums').deleteMany({ source: AUDIUS, ownerOxyUserId: { $in: [null, ''] } })).deletedCount ?? 0;
  const artistsDirect =
    (await d.collection('catalogentities').deleteMany({ source: AUDIUS, ownerOxyUserId: { $in: [null, ''] } })).deletedCount ?? 0;
  const playlistsDirect =
    (await d.collection('playlists').deleteMany({
      source: AUDIUS,
      ownerOxyUserId: { $in: [null, '', 'system:audius'] },
    })).deletedCount ?? 0;

  const albumsOrphaned = await deleteTracklessContainers('albums', 'albumId');
  const artistsOrphaned = await deleteTracklessContainers('catalogentities', 'artistId');

  // A playlist is empty when no join rows remain for it.
  const playlistIdsWithTracks = new Set(
    (await d.collection('playlisttracks').distinct('playlistId', {})).map((id) => String(id)),
  );
  const emptyPlaylists = (
    await d
      .collection('playlists')
      .find({ ownerOxyUserId: { $in: [null, '', 'system:audius'] } }, { projection: { _id: 1 } })
      .toArray()
  )
    .map((doc) => doc._id)
    .filter((id) => !playlistIdsWithTracks.has(id.toString()));
  const playlistsOrphaned = emptyPlaylists.length
    ? (await d.collection('playlists').deleteMany({ _id: { $in: emptyPlaylists } })).deletedCount ?? 0
    : 0;

  // 6. Mirrored Audius artwork.
  const imageAssets = (await d.collection('imageassets').deleteMany({ provider: AUDIUS })).deletedCount ?? 0;

  // 7. Residual provider fields on anything that survived.
  let externalIdsUnset = 0;
  for (const name of ['tracks', 'albums', 'playlists', 'catalogentities']) {
    const result = await d
      .collection(name)
      .updateMany({ 'externalIds.audiusId': { $exists: true } }, { $unset: { 'externalIds.audiusId': '' } });
    externalIdsUnset += result.modifiedCount ?? 0;
  }
  const streamUrls = await d
    .collection('tracks')
    .updateMany({ streamUrl: { $exists: true } }, { $unset: { streamUrl: '' } });
  externalIdsUnset += streamUrls.modifiedCount ?? 0;

  // 8. The removed per-user preference.
  const preferencesUnset =
    (await d
      .collection('usermusicpreferences')
      .updateMany({ directAudiusStreaming: { $exists: true } }, { $unset: { directAudiusStreaming: '' } })).modifiedCount ?? 0;

  const claimedContainersKept =
    (await d.collection('albums').countDocuments({ source: AUDIUS })) +
    (await d.collection('catalogentities').countDocuments({ source: AUDIUS })) +
    (await d.collection('playlists').countDocuments({ source: AUDIUS }));

  return {
    tracks,
    playlistTracks,
    albums: albumsDirect + albumsOrphaned,
    artists: artistsDirect + artistsOrphaned,
    playlists: playlistsDirect + playlistsOrphaned,
    imageAssets,
    externalIdsUnset,
    preferencesUnset,
    claimedContainersKept,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectToDatabase();

  const before = await reportAudiusFootprint();
  logger.info('[purge-audius] footprint (nothing written yet)', { ...before });

  if (!apply) {
    logger.info('[purge-audius] DRY RUN — re-run with --apply to perform the purge');
    return;
  }

  const purged = await purgeAudiusData();
  logger.info('[purge-audius] purge complete', { ...purged });
  if (purged.claimedContainersKept > 0) {
    logger.warn('[purge-audius] claimed Audius-sourced containers were KEPT — review by hand', {
      count: purged.claimedContainersKept,
    });
  }
}

if (require.main === module) {
  main()
    .then(() => mongoose.connection.close())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[purge-audius] fatal error', { err });
      mongoose.connection.close().finally(() => process.exit(1));
    });
}
