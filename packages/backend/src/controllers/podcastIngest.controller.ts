/**
 * Asynchronous episode ingest: reserve an episode while a user's session is
 * live, attach the audio later with no session at all.
 *
 * Alia generates an episode in a background worker minutes after the request.
 * Syra authenticates exactly one thing — a user's Oxy JWT — and service-token
 * delegation is dead platform-wide, so by the time the audio exists there is no
 * credential in the call. The two endpoints here are the two halves of the
 * answer:
 *
 *   POST /api/podcasts/:id/episodes/draft      requireAuth + owner  -> a ticket
 *   POST /api/podcasts/episodes/:id/ingest     the TICKET is the auth
 *
 * What the ticket is narrowed to, and why each narrowing exists, is
 * `services/podcasts/ingestToken.ts`. What makes it single-use is
 * `db/podcasts/ingestTickets.ts` and the table it writes. This file is where
 * both are ENFORCED, and the order of the checks below is part of that: the
 * capability is verified, then bound to this episode, then to the show's CURRENT
 * owner, then to an episode state that may still receive audio — and only then
 * is anything written.
 */

import multer from 'multer';
import type { Response } from 'express';
import { isLiveEntityId, uuidv7 } from '@oxyhq/db';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { getRequiredOxyUserId } from '@oxyhq/core/server';
import {
  createEpisodeDraftRequestSchema,
  ingestEpisodeAudioRequestSchema,
  type AudioSource,
  type EpisodePerson,
} from '@syra/shared-types';
import { getDb } from '../db/postgres';
import { findPodcastForOwner } from '../db/podcasts/podcasts';
import { findEpisodeById, insertEpisode, updateEpisode } from '../db/podcasts/episodes';
import { claimIngestTicket, insertIngestTicket, releaseIngestTicket } from '../db/podcasts/ingestTickets';
import { loadShowContext, toEpisodeDtos } from '../db/podcasts/hydrate';
import { viewerOwnsShow } from '../db/podcasts/visibility';
import { mintIngestTicket, verifyIngestTicket } from '../services/podcasts/ingestToken';
import { enqueueEpisodeIngest } from '../services/podcasts/ingestEpisode';
import { buildCreatorPersons, makeOxyUsersFetcher } from '../services/podcasts/resolvePersons';
import { getS3PodcastEpisodeAudioKey } from '../config/s3.config';
import { uploadToS3 } from '../services/s3Service';
import { getParam } from '../utils/reqParams';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';
import { oxy } from '../oxyClient';

/**
 * The header the ticket travels in.
 *
 * NOT `Authorization: Bearer`, and that is deliberate: this route is mounted
 * under `createOptionalOxyAuth`, which reads that header and would try to verify
 * an ingest ticket as an Oxy session token. A dedicated header keeps the two
 * credential spaces from ever being handed each other's material — and keeps the
 * ticket out of the query string, where it would land in every access log and
 * `Referer` on the way past.
 */
const INGEST_TICKET_HEADER = 'x-ingest-ticket';

/** Same limits and the same field name as `uploadEpisode` — one upload contract, not two. */
const AUDIO_FORMAT_BY_MIME: Record<string, AudioSource['format']> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/vorbis': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

const ingestAudioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_FORMAT_BY_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('Invalid file type. Only audio files are allowed.'));
  },
}).single('audioFile');

interface AudioUploadRequest extends AuthRequest {
  file?: Express.Multer.File;
}

/**
 * The episode states that may still RECEIVE audio.
 *
 * `ready` is absent, and it is the important absence: an episode that already
 * went ready has media people may already be listening to, and a ticket must not
 * be able to replace it even inside its own 24-hour window. `failed` IS present
 * because a retry after a transcode failure is the case this whole path exists
 * to serve. `unavailable` is absent too — it is an unpublished episode, and
 * quietly re-arming one is not something a background worker should be able to
 * do.
 */
const INGESTIBLE_STATUSES: readonly string[] = ['processing', 'failed'];

// ── Draft ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/podcasts/:id/episodes/draft — reserve an episode, get a ticket.
 *
 * Owner-scoped through `findPodcastForOwner`, so "not yours" and "no such show"
 * are one 403 and this cannot be used to probe for a private show's id — the same
 * rule `uploadEpisode` follows.
 *
 * The row and the ticket are written in ONE transaction. A ticket whose
 * `episode_ingest_tickets` row failed to land would be a capability with no
 * redemption record, and the redemption path treats a missing row as REFUSED —
 * so the failure would be silent at mint time and only visible 20 minutes later
 * as an unexplained rejection.
 */
export async function createEpisodeDraft(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);
  const id = getParam(req, 'id');
  if (!isLiveEntityId(id)) {
    res.status(400).json({ error: 'Invalid podcast ID' });
    return;
  }

  const parsed = createEpisodeDraftRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid draft payload', details: parsed.error.issues });
    return;
  }
  const input = parsed.data;

  const podcast = await findPodcastForOwner(id, userId);
  if (!podcast || podcast.source !== 'syra') {
    res.status(403).json({ error: 'You do not own this podcast' });
    return;
  }

  const title = input.title.trim();
  if (!title) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }

  // Hosts & Guests — validated HERE, while a real user is on the call. The
  // ticket holder can never set them, so this is the only chance.
  let persons: EpisodePerson[] = [];
  if (input.hosts?.length || input.guests?.length) {
    const built = await buildCreatorPersons(
      { hosts: input.hosts, guests: input.guests },
      makeOxyUsersFetcher(oxy)
    );
    if (built.invalidIds.length > 0) {
      res
        .status(400)
        .json({ error: 'hosts/guests must be valid Oxy user ids', invalidIds: built.invalidIds });
      return;
    }
    persons = built.persons;
  }

  const episodeId = uuidv7();
  const ticket = mintIngestTicket({
    episodeId,
    podcastId: podcast.id,
    ownerOxyUserId: userId,
  });

  await getDb().transaction(async (tx) => {
    await insertEpisode(
      {
        id: episodeId,
        podcastId: podcast.id,
        podcastTitle: podcast.title,
        title,
        description: input.description,
        summary: input.summary,
        guid: episodeId,
        // No audio yet, so no duration is known and none is guessed. The ticket
        // holder supplies it with the file.
        duration: 0,
        pubDate: new Date(),
        season: input.season,
        episodeNumber: input.episodeNumber,
        episodeType: input.episodeType ?? 'full',
        explicit: input.explicit ?? false,
        aiGenerated: input.aiGenerated ?? false,
        source: 'syra',
        /**
         * The URL is written NOW even though the object does not exist yet.
         * It is derived from the episode id, so it is knowable in advance, and
         * `ingestEpisode` reads it as the "there is source audio" signal — an
         * episode drafted and never ingested therefore fails its transcode
         * loudly rather than being skipped as a row with nothing to do.
         */
        audioSourceUrl: `/api/podcasts/episodes/${episodeId}/audio`,
        status: 'processing',
      },
      { persons },
      { recordOnShow: true },
      tx
    );

    await insertIngestTicket(tx, {
      jti: ticket.claims.jti,
      episodeId,
      expiresAt: ticket.expiresAt,
    });
  });

  res.status(201).json({
    data: {
      episodeId,
      ingestTicket: ticket.token,
      expiresAt: ticket.expiresAt.toISOString(),
    },
  });
}

// ── Ingest ────────────────────────────────────────────────────────────────────

/** Every refusal this endpoint can make, and the status each one answers with. */
type IngestRefusal =
  | { status: 400; error: string }
  | { status: 401; error: string }
  | { status: 404; error: string }
  | { status: 409; error: string };

/**
 * Everything that must be true before a single byte is written, in the order it
 * has to be checked.
 *
 * Split out from the handler so the sequence is readable as a sequence — and so
 * every refusal is one `return`, rather than a nest of `if`s inside a multer
 * callback where an early `return` is easy to forget.
 */
async function authorizeIngest(
  req: AuthRequest,
  episodeId: string
): Promise<
  | { ok: true; jti: string; podcastId: string; format: AudioSource['format']; file: Express.Multer.File }
  | { ok: false; refusal: IngestRefusal }
> {
  const raw = req.headers[INGEST_TICKET_HEADER];
  const token = typeof raw === 'string' ? raw : undefined;
  if (!token) {
    return { ok: false, refusal: { status: 401, error: 'Ingest ticket required' } };
  }

  const claims = verifyIngestTicket(token);
  if (!claims) {
    return { ok: false, refusal: { status: 401, error: 'Invalid ingest ticket' } };
  }

  /**
   * The ticket is for ONE episode. Compared against the id in the URL before
   * anything is loaded, so a ticket for episode A cannot even cause a read of
   * episode B — the answer is the same 404 an id naming nothing gets, because a
   * holder pointing a valid ticket at somebody else's episode must not learn
   * whether it exists.
   */
  if (claims.episodeId !== episodeId) {
    return { ok: false, refusal: { status: 404, error: 'Episode not found' } };
  }

  const found = await findEpisodeById(episodeId);
  if (!found || found.show.id !== claims.podcastId) {
    return { ok: false, refusal: { status: 404, error: 'Episode not found' } };
  }
  const { episode, show } = found;

  /**
   * Ownership as it stands NOW, not as the ticket remembers it.
   *
   * A show can change hands inside a 24-hour window (`claimPodcast`), and a
   * ticket minted by the previous owner has to stop working the moment it does.
   * The signed `ownerOxyUserId` records who was entitled at mint time; this
   * compares that against who is entitled today, and both have to agree.
   */
  if (!viewerOwnsShow(show, claims.ownerOxyUserId)) {
    return { ok: false, refusal: { status: 404, error: 'Episode not found' } };
  }

  if (!INGESTIBLE_STATUSES.includes(episode.status)) {
    return {
      ok: false,
      refusal: { status: 409, error: 'Episode is not awaiting audio' },
    };
  }

  /**
   * A second, independent test of the same fact. `status` is a workflow flag
   * that several paths write; `hls_master_key` is set by exactly one
   * (`setEpisodeHls`) and only after media really landed. Either one alone would
   * be enough today — together they mean a future writer that moves an episode
   * back to `processing` still cannot make its finished audio replaceable.
   */
  if (episode.hlsMasterKey) {
    return { ok: false, refusal: { status: 409, error: 'Episode already has audio' } };
  }

  const file = (req as AudioUploadRequest).file;
  if (!file) {
    return { ok: false, refusal: { status: 400, error: 'Audio file is required' } };
  }
  const format = AUDIO_FORMAT_BY_MIME[file.mimetype];
  if (!format) {
    return { ok: false, refusal: { status: 400, error: 'Unsupported audio format' } };
  }

  return { ok: true, jti: claims.jti, podcastId: show.id, format, file };
}

/**
 * POST /api/podcasts/episodes/:id/ingest — attach the audio, authenticated by
 * the ticket alone.
 *
 * ## Why the ticket is claimed BEFORE the upload
 *
 * The claim is the single-use boundary, and putting it after the upload would
 * let two concurrent redemptions of one ticket both reach S3. Claiming first
 * means the loser of that race never writes anything.
 *
 * The cost is that a failure after the claim would burn a capability a
 * background worker cannot re-obtain without a user session, so a HANDLED
 * failure releases it (`releaseIngestTicket`). A crash does not, which is the
 * safe direction: an unreleased ticket costs one wasted draft, while a ticket
 * released by a process that then died holding the audio would be a live
 * capability nobody is accounting for.
 */
export async function ingestEpisodeAudio(req: AuthRequest, res: Response): Promise<void> {
  ingestAudioUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      res.status(400).json({ error: 'Upload error', message: uploadErr.message });
      return;
    }

    const episodeId = getParam(req, 'id');
    if (!isLiveEntityId(episodeId)) {
      res.status(400).json({ error: 'Invalid episode ID' });
      return;
    }

    const parsed = ingestEpisodeAudioRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid ingest metadata', details: parsed.error.issues });
      return;
    }
    const fields = parsed.data;

    const authorized = await authorizeIngest(req, episodeId);
    if (!authorized.ok) {
      res.status(authorized.refusal.status).json({ error: authorized.refusal.error });
      return;
    }

    // The single-use boundary. Everything above this line is a read.
    const claimed = await claimIngestTicket(getDb(), authorized.jti, episodeId);
    if (!claimed) {
      res.status(409).json({ error: 'Ingest ticket already used or expired' });
      return;
    }

    try {
      const audioKey = getS3PodcastEpisodeAudioKey(episodeId, authorized.podcastId, authorized.format);
      await uploadToS3(audioKey, authorized.file.buffer, { contentType: authorized.file.mimetype });

      /**
       * The field allowlist, assigned one by one and never spread — the same
       * discipline every other write in this vertical follows, and here it IS
       * the capability's boundary. `title`, `explicit`, `episodeType`,
       * `aiGenerated`, the credits and every storage column are absent because
       * the authenticated user set them at draft time and the ticket holder has
       * no standing to change them.
       */
      const updated = await updateEpisode(episodeId, {
        audioSourceFormat: authorized.format,
        ...(fields.duration === undefined ? {} : { duration: fields.duration }),
        ...(fields.season === undefined ? {} : { season: fields.season }),
        ...(fields.episodeNumber === undefined ? {} : { episodeNumber: fields.episodeNumber }),
        ...(fields.description === undefined ? {} : { description: fields.description }),
        ...(fields.summary === undefined ? {} : { summary: fields.summary }),
        // Back to `processing` explicitly, so a RETRY after a failed transcode
        // does not leave the episode reading `failed` while its new audio is
        // being packaged.
        status: 'processing',
      });

      if (!updated) {
        // Unreachable: `authorizeIngest` loaded this row. Treated as a failure
        // rather than ignored, so the ticket is released instead of spent on a
        // write that did not happen.
        throw new Error(`ingestEpisodeAudio: episode ${episodeId} vanished mid-redemption`);
      }

      enqueueEpisodeIngest(episodeId);

      /**
       * Serialized as a NON-OWNER, on purpose.
       *
       * The redeemer holds a capability, not the owner's identity — so the
       * response carries what any listener would see and not `hlsMasterKey` or
       * `cache.s3Key`. A worker has no use for storage keys, and handing them
       * back would quietly turn a write capability into a read of internal
       * layout.
       *
       * 202, not 201: the episode exists but its audio is still being packaged.
       */
      const shows = await loadShowContext([updated]);
      const [dto] = await toEpisodeDtos([updated], undefined, shows);
      res.status(202).json({ data: dto });
    } catch (err) {
      await releaseIngestTicket(authorized.jti).catch((releaseErr) =>
        logger.error('[podcasts] failed to release an ingest ticket', {
          episodeId,
          err: describeErrorSafely(releaseErr),
        })
      );
      logger.error('[podcasts] episode ingest redemption failed', {
        episodeId,
        err: describeErrorSafely(err),
      });
      if (!res.headersSent) res.status(500).json({ error: 'Failed to ingest episode audio' });
    }
  });
}
