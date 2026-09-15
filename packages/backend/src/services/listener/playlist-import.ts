import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { publicColumns } from '@oxy.so/db/assert';
import type { PlaylistImportEntry } from '@syra/shared-types';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { playlists, playlistTracks } from '../../db/schema/library';
import { playlistImportReceipts } from '../../db/schema/listener-tools';
import { PROTECTED_COLUMNS_BY_TABLE } from '../../db/schema/protectedColumns';
import { playableTrackFilter } from '../../db/catalog/visibility';
import { toTrackDtos } from '../../db/catalog/hydrate';
import { ListenerAccessError } from './access-error';

/** Strong id first, then ISRC, then exact title AND artist. Never guess a match. */
export async function previewPlaylistImport(entries: PlaylistImportEntry[]) {
  const matches: string[][] = Array.from({ length: entries.length }, () => []);
  let cursor = 0;
  // Eight in-flight index/exact-match queries, even for a 500-row export.
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) {
      const index = cursor++;
      const entry = entries[index];
      const isrc = entry.isrc?.replace(/[-\s]/g, '').toUpperCase();
      const predicate = entry.catalogId ? eq(tracks.id, entry.catalogId)
        : isrc ? eq(tracks.externalIsrc, isrc)
          : and(sql`lower(${tracks.title}) = lower(${entry.title ?? ''})`, sql`lower(${tracks.artistName}) = lower(${entry.artist ?? ''})`);
      const rows = await getDb().select({ id: tracks.id }).from(tracks)
        .where(and(playableTrackFilter(), predicate)).limit(2);
      matches[index] = rows.map((row) => row.id);
    }
  }));
  const ids = [...new Set(matches.flatMap((match) => match.length === 1 ? match : []))];
  const rows = ids.length ? await getDb().select(publicColumns(tracks, PROTECTED_COLUMNS_BY_TABLE))
    .from(tracks).where(and(playableTrackFilter(), inArray(tracks.id, ids))) : [];
  const byId = new Map((await toTrackDtos(rows)).map((track) => [track.id, track]));
  return { items: matches.map((match, index) => ({
    index, status: match.length > 1 ? 'ambiguous' as const : match.length === 1 && byId.has(match[0]) ? 'matched' as const : 'missing' as const,
    track: match.length === 1 ? byId.get(match[0]) ?? null : null,
  })) };
}

/** Confirmation is atomic and account-scoped/idempotent. No remote file is fetched. */
export async function commitPlaylistImport(userId: string, username: string, name: string, trackIds: string[], requestId: string) {
  const requestHash = createHash('sha256').update(JSON.stringify({ name, trackIds })).digest('hex');
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`playlist-import:${userId}:${requestId}`}, 0))`);
    const [receipt] = await tx.select({ playlistId: playlistImportReceipts.playlistId, requestHash: playlistImportReceipts.requestHash })
      .from(playlistImportReceipts).where(and(eq(playlistImportReceipts.oxyUserId, userId), eq(playlistImportReceipts.requestId, requestId)));
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new ListenerAccessError(409, 'This import request was already used for different contents');
      return { playlistId: receipt.playlistId };
    }
    const rows = await tx.select({ id: tracks.id, duration: tracks.duration }).from(tracks)
      .where(and(playableTrackFilter(), inArray(tracks.id, trackIds)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    if (trackIds.some((id) => !byId.has(id))) throw new ListenerAccessError(409, 'Some recordings are no longer available. Preview the import again');
    const [playlist] = await tx.insert(playlists).values({
      name, ownerOxyUserId: userId, ownerUsername: username, visibility: 'private',
      trackCount: trackIds.length, totalDuration: trackIds.reduce((total, id) => total + (byId.get(id)?.duration ?? 0), 0),
    }).returning({ id: playlists.id });
    if (!playlist) throw new Error('Import playlist insert did not return an id');
    await tx.insert(playlistTracks).values(trackIds.map((trackId, position) => ({ playlistId: playlist.id, trackId, position, addedAt: new Date(), addedBy: userId })));
    await tx.insert(playlistImportReceipts).values({ oxyUserId: userId, requestId, requestHash, playlistId: playlist.id });
    return { playlistId: playlist.id };
  });
}
