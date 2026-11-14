/**
 * Producing one generated episode: script → one voiced line at a time → one
 * file → the episode's source audio → Syra's own ingest.
 *
 * The last step is the same one an upload takes. The file is stored as the
 * episode's original (`putSourceAudio`) and `ingestEpisode` makes it the show
 * owner's Oxy file and, for a public show, the HLS ladder — so a generated
 * episode is served, listed, gated and deleted exactly like an uploaded one.
 *
 * Every failure is recorded on the job, in words the owner can read, and the
 * episode is marked `failed` so it never sits at `processing` with no audio.
 * Nothing is billed here: Oxy meters each Kaana request against the person it
 * is attributed to.
 */

import {
  findGeneration,
  findGenerationProfile,
  priorGeneratedEpisodes,
  updateGeneration,
  type EpisodeGenerationRow,
  type GenerationPatch,
  type GenerationProfileRow,
} from '../../../db/podcasts/generations';
import { findEpisodeById, setEpisodeStatus, updateEpisode } from '../../../db/podcasts/episodes';
import type { EpisodeRow, PodcastRow } from '../../../db/podcasts/serialize';
import type { GenerationSegment } from '../../../db/schema/podcastGeneration';
import { describeErrorSafely } from '../../../utils/error';
import { logger } from '../../../utils/logger';
import { getS3PodcastEpisodeAudioKey, putSourceAudio } from '../../oxyFiles/audioStorage';
import { ingestEpisode } from '../ingestEpisode';
import { assembleEpisodeAudio, type AssembledAudio } from './audio';
import { describeKaanaFailure, kaanaForAccount, type GenerationKaana } from './kaana';
import {
  buildScriptSystemPrompt,
  buildScriptUserPrompt,
  parseScript,
  type ParsedScript,
} from './script';
import { speakableText, splitForSpeech } from './speech';

/** The power level a script is written at. Kaana chooses the model within it. */
export const SCRIPT_POWER_LEVEL = 'medium';
const SCRIPT_MAX_OUTPUT_TOKENS = 4096;
/** A reply that is not a usable script is asked for again, once. */
const SCRIPT_ATTEMPTS = 2;
/** Lines voiced at once. */
const SPEECH_BATCH = 3;
/** Earlier episodes whose subject the script is told. */
const SUBJECT_LEDGER_LIMIT = 50;
/** Used when the catalogue states no per-request limit. */
const DEFAULT_MAX_SPEECH_CHARACTERS = 4000;

export interface GenerationDeps {
  kaanaFor(accountId: string): Promise<GenerationKaana>;
  assemble(lines: readonly Buffer[]): Promise<AssembledAudio>;
  storeSource: typeof putSourceAudio;
  ingest(episodeId: string): Promise<void>;
}

const DEFAULT_DEPS: GenerationDeps = {
  kaanaFor: kaanaForAccount,
  assemble: assembleEpisodeAudio,
  storeSource: putSourceAudio,
  ingest: (episodeId) => ingestEpisode(episodeId),
};

/** A failure whose message is the owner's to read. */
class GenerationFailure extends Error {}

const FINISHED = new Set(['completed', 'failed']);

export async function runEpisodeGeneration(
  episodeId: string,
  deps: GenerationDeps = DEFAULT_DEPS,
): Promise<void> {
  const generation = await findGeneration(episodeId);
  // A job delivered twice, or for an episode deleted since: nothing to do.
  if (!generation || FINISHED.has(generation.status)) return;
  const found = await findEpisodeById(episodeId);
  if (!found) return;
  const { episode, show } = found;

  const record = (patch: GenerationPatch) => updateGeneration(episodeId, patch);
  let kaana: GenerationKaana | undefined;
  try {
    const profile = await findGenerationProfile(show.id);
    if (!profile || !show.ownerOxyUserId) {
      throw new GenerationFailure('This show is not set up for generated episodes.');
    }
    kaana = await deps.kaanaFor(generation.requestedByOxyUserId);

    await record({ status: 'writing', progress: 5 });
    const script = await writeScript(kaana, show, episode, generation, profile);
    const title = generation.requestedTitle ?? script.title ?? episode.title;
    const segments: GenerationSegment[] = script.segments.map((segment) => ({ ...segment }));
    // The subject is recorded now, before minutes of speech: an episode queued
    // meanwhile is told it is taken.
    await record({
      status: 'recording',
      progress: 15,
      topic: generation.topic ?? script.topic,
      segments,
    });
    await updateEpisode(episodeId, {
      title,
      description: script.description || undefined,
      summary: script.summary || undefined,
    });

    const lines = await voiceLines(kaana, profile, segments, (done) =>
      record({ segments, progress: 15 + Math.round((done / segments.length) * 60) }),
    );
    if (lines.length === 0) {
      throw new GenerationFailure('No audio could be generated for this episode.');
    }

    await record({ status: 'assembling', segments, progress: 80 });
    const assembled = await deps.assemble(lines);

    await record({ status: 'publishing', progress: 90 });
    await deps.storeSource(
      getS3PodcastEpisodeAudioKey(episodeId, show.id, 'mp3'),
      assembled.audio,
      {
        contentType: 'audio/mpeg',
        owner: { kind: 'account', oxyUserId: show.ownerOxyUserId },
      },
    );
    await updateEpisode(episodeId, {
      audioSourceFormat: 'mp3',
      duration: assembled.durationSec,
      status: 'processing',
    });
    await deps.ingest(episodeId);

    await record({ status: 'completed', progress: 100, recap: script.recap || null });
  } catch (error) {
    const message =
      error instanceof GenerationFailure
        ? error.message
        : ((await describeKaanaFailure(error)) ?? 'Episode generation failed.');
    logger.error('[generation] episode generation failed', {
      episodeId,
      podcastId: show.id,
      err: describeErrorSafely(error),
    });
    await record({ status: 'failed', error: message }).catch(() => undefined);
    await setEpisodeStatus(episodeId, 'failed').catch((err) =>
      logger.error('[generation] could not mark the episode failed', {
        episodeId,
        err: describeErrorSafely(err),
      }),
    );
  } finally {
    kaana?.dispose();
  }
}

async function writeScript(
  kaana: GenerationKaana,
  show: PodcastRow,
  episode: EpisodeRow,
  generation: EpisodeGenerationRow,
  profile: GenerationProfileRow,
): Promise<ParsedScript> {
  const episodeNumber = episode.episodeNumber ?? 1;
  const previously = await priorGeneratedEpisodes(show.id, episodeNumber, SUBJECT_LEDGER_LIMIT);
  const system = buildScriptSystemPrompt(profile.format, profile.speakers);
  const user = buildScriptUserPrompt({
    brief: profile.brief,
    showTitle: show.title,
    topic: generation.topic,
    episodeNumber,
    notes: generation.notes,
    previously,
  });
  const castNames = new Set(profile.speakers.map((speaker) => speaker.name));

  for (let attempt = 1; attempt <= SCRIPT_ATTEMPTS; attempt += 1) {
    const response = await kaana.responses.create({
      model: SCRIPT_POWER_LEVEL,
      input: [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text: user }] },
      ],
      maxOutputTokens: SCRIPT_MAX_OUTPUT_TOKENS,
      responseFormat: { type: 'json_object', repair: true },
    });
    const reply = response.output
      .flatMap((message) => message.content)
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
    const parsed = parseScript(reply, castNames, generation.topic === null);
    if (parsed) return parsed;
    logger.warn('[generation] script reply was not usable', {
      episodeId: episode.id,
      attempt,
      replyLength: reply.length,
    });
  }
  throw new GenerationFailure('The episode script could not be written. Please try again.');
}

/**
 * Speak every line in the show's cast, in playback order. A line that fails is
 * marked `renderFailed` and left out: one lost line is a slightly abrupt
 * episode, refusing over it is no episode — but the job says which.
 */
async function voiceLines(
  kaana: GenerationKaana,
  profile: GenerationProfileRow,
  segments: GenerationSegment[],
  onProgress: (done: number) => Promise<unknown>,
): Promise<Buffer[]> {
  const model = await kaana.models.get(profile.speechModel);
  const maxCharacters = model.audio?.maxInputCharacters ?? DEFAULT_MAX_SPEECH_CHARACTERS;
  const voices = new Map(profile.speakers.map((speaker) => [speaker.name, speaker.voiceId]));
  const rendered = new Map<number, Buffer>();

  const voice = async (segment: GenerationSegment): Promise<Buffer | null> => {
    const voiceId = voices.get(segment.speaker);
    const pieces = splitForSpeech(speakableText(segment.text), maxCharacters);
    if (voiceId === undefined || pieces.length === 0) return null;
    const parts: Buffer[] = [];
    for (const input of pieces) {
      const speech = await kaana.audio.speech({
        model: profile.speechModel,
        input,
        voice: voiceId,
        response_format: 'mp3',
      });
      parts.push(Buffer.from(speech.audio));
    }
    return Buffer.concat(parts);
  };

  for (let start = 0; start < segments.length; start += SPEECH_BATCH) {
    const batch = segments.slice(start, start + SPEECH_BATCH);
    const results = await Promise.allSettled(batch.map(voice));
    for (const [offset, result] of results.entries()) {
      const segment = batch[offset];
      if (!segment) continue;
      if (result.status === 'fulfilled' && result.value !== null) {
        rendered.set(start + offset, result.value);
      } else {
        segment.renderFailed = true;
        logger.warn('[generation] a line could not be voiced', {
          segmentIndex: start + offset,
          err: result.status === 'rejected' ? describeErrorSafely(result.reason) : 'nothing to say',
        });
      }
    }
    await onProgress(Math.min(start + SPEECH_BATCH, segments.length));
  }

  return segments.flatMap((_, index) => {
    const buffer = rendered.get(index);
    return buffer ? [buffer] : [];
  });
}
