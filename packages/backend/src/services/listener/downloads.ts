import { and, eq } from 'drizzle-orm';
import { publicColumns } from '@oxy.so/db/assert';
import { downloadGrantSchema } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import { catalogEntities, tracks } from '../../db/schema/catalog';
import { trackDownloadPolicies } from '../../db/schema/listener-tools';
import { PROTECTED_COLUMNS_BY_TABLE } from '../../db/schema/protectedColumns';
import { playableTrackFilter } from '../../db/catalog/visibility';
import { toTrackDtos } from '../../db/catalog/hydrate';
import { getTrackS3Key } from '../audioStorageService';
import { getObjectMetadata, getPresignedUrl } from '../s3Service';
import { ListenerAccessError } from './access-error';

const DOWNLOAD_URL_SECONDS = 5 * 60;
const DOWNLOAD_LEASE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export async function readDownloadPolicy(trackId: string, userId?: string) {
  const [row] = await getDb().select({ allowed: trackDownloadPolicies.allowed, owner: catalogEntities.ownerOxyUserId })
    .from(tracks).innerJoin(catalogEntities, eq(catalogEntities.id, tracks.artistId))
    .leftJoin(trackDownloadPolicies, eq(trackDownloadPolicies.trackId, tracks.id))
    .where(and(eq(tracks.id, trackId), playableTrackFilter(), eq(tracks.status, 'ready'))).limit(1);
  if (!row) throw new ListenerAccessError(404, 'Recording not available');
  return { allowed: row.allowed === true, canEdit: Boolean(userId && row.owner === userId) };
}

/** The actual artist owner opts in; listener preferences cannot grant download rights. */
export async function setDownloadPolicy(trackId: string, userId: string, allowed: boolean) {
  await getDb().transaction(async (tx) => {
    const [track] = await tx.select({ artistId: tracks.artistId }).from(tracks).where(eq(tracks.id, trackId));
    if (!track) throw new ListenerAccessError(404, 'Recording not found');
    const [artist] = await tx.select({ owner: catalogEntities.ownerOxyUserId }).from(catalogEntities)
      .where(eq(catalogEntities.id, track.artistId)).for('update');
    if (artist?.owner !== userId) throw new ListenerAccessError(403, 'Only the artist owner can change download permission');
    await tx.insert(trackDownloadPolicies).values({ trackId, allowed })
      .onConflictDoUpdate({ target: trackDownloadPolicies.trackId, set: { allowed, updatedAt: new Date() } });
  });
  return { allowed, canEdit: true };
}

export async function grantDownload(trackId: string) {
  const [row] = await getDb().select({ track: publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE),
    sourceUrl: tracks.audioSourceUrl, format: tracks.audioSourceFormat })
    .from(tracks).innerJoin(trackDownloadPolicies, eq(trackDownloadPolicies.trackId, tracks.id))
    .where(and(eq(tracks.id, trackId), playableTrackFilter(), eq(tracks.status, 'ready'), eq(trackDownloadPolicies.allowed, true))).limit(1);
  if (!row) throw new ListenerAccessError(403, 'The creator has not authorized offline downloads for this recording');
  const format = downloadGrantSchema.shape.extension.safeParse(row.format);
  if (!format.success || !row.sourceUrl) throw new ListenerAccessError(409, 'This recording is not available in a supported download format');
  const [track] = await toTrackDtos([row.track]);
  if (!track) throw new ListenerAccessError(404, 'Recording unavailable');
  const key = getTrackS3Key({ id: track.id, title: track.title, artistId: track.artistId, albumId: track.albumId,
    audioSource: { url: row.sourceUrl, format: format.data } });
  const metadata = await getObjectMetadata(key);
  if (!metadata?.contentLength || metadata.contentLength > MAX_DOWNLOAD_BYTES) {
    throw new ListenerAccessError(409, 'This recording is missing or exceeds the 100 MB offline file limit');
  }
  const now = Date.now();
  return { track, url: await getPresignedUrl(key, DOWNLOAD_URL_SECONDS), byteLength: metadata.contentLength,
    extension: format.data, downloadExpiresAt: new Date(now + DOWNLOAD_URL_SECONDS * 1000).toISOString(),
    leaseExpiresAt: new Date(now + DOWNLOAD_LEASE_MS).toISOString() };
}
