/**
 * Whether Oxy may hand a play session's AES-128 key to the player (OxyHQ/oxy ADR
 * 0043 stage 4c, `stream.key_authorization`).
 *
 * Every play session Syra opens asks for `keyAuthorization: 'webhook'`, so Oxy
 * releases the key only after this answers `allow` — the entitlement decision
 * stays Syra's, made per play and re-made (Oxy remembers an answer for about a
 * minute) for as long as the session plays. It is the SAME decision the legacy
 * key endpoints make (`stream.controller.ts`, `podcastAudio.controller.ts`, the
 * locker's `/stream/key`), read off the rows that use the file:
 *
 * - a catalogue track: playable (`isTrackPlayable`: available, not taken down)
 *   and a signed-in listener — the catalogue never streams to a guest;
 * - a locker upload: its OWNER, while the upload is not deleted;
 * - an episode: not `unavailable`; a private show's only to its owner, any
 *   other show's to a signed-in listener.
 *
 * Several rows may share one file (the same bytes in two uploads of one owner,
 * one enclosure imported once): the key is released if ANY of them entitles
 * this listener. A file Syra marked withdrawn (trashed, deleted, taken down —
 * Oxy's own file events) entitles nobody. Fail closed: no row, no key.
 *
 * Bounded: three indexed lookups (`*_audio_file_id_idx`), well inside Oxy's
 * three-second deadline.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { tracks } from '../../db/schema/catalog';
import { userUploads } from '../../db/schema/creators';
import { episodes, podcasts } from '../../db/schema/podcasts';
import { oxyAudioFiles } from '../../db/schema/oxyFiles';
import { isPlayableTrack } from '../../db/catalog/visibility';

export interface KeyAuthorizationSession {
  fileId: string;
  /** The listener the session was opened for; `null` for one opened for nobody. */
  endUserId: string | null;
}

export async function authorizeAudioKey(session: KeyAuthorizationSession): Promise<boolean> {
  const { fileId, endUserId } = session;
  if (!endUserId) return false;

  const db = getDb();
  const [file] = await db
    .select({ status: oxyAudioFiles.status })
    .from(oxyAudioFiles)
    .where(eq(oxyAudioFiles.fileId, fileId))
    .limit(1);
  if (file && file.status !== 'active') return false;

  const [trackRows, uploadRows, episodeRows] = await Promise.all([
    db
      .select({
        isAvailable: tracks.isAvailable,
        copyrightRemoved: tracks.copyrightRemoved,
        status: tracks.status,
      })
      .from(tracks)
      .where(eq(tracks.audioFileId, fileId)),
    db
      .select({ ownerOxyUserId: userUploads.ownerOxyUserId })
      .from(userUploads)
      .where(and(eq(userUploads.audioFileId, fileId), isNull(userUploads.deletedAt))),
    db
      .select({ visibility: podcasts.visibility, ownerOxyUserId: podcasts.ownerOxyUserId })
      .from(episodes)
      .innerJoin(podcasts, eq(podcasts.id, episodes.podcastId))
      .where(and(eq(episodes.audioFileId, fileId), ne(episodes.status, 'unavailable'))),
  ]);

  if (trackRows.some((track) => isPlayableTrack(track) && track.status !== 'failed')) return true;
  if (uploadRows.some((upload) => upload.ownerOxyUserId === endUserId)) return true;
  return episodeRows.some(
    (episode) => episode.visibility !== 'private' || episode.ownerOxyUserId === endUserId,
  );
}
