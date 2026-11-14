/**
 * The prompts that turn a show's brief into one episode's script, and the
 * parser that reads the script back.
 *
 * Three rules shape the prompt, and each one is a failure it was written to
 * stop:
 *
 *  - **The cast is given, not invented.** Speaker names come from the show's
 *    profile, so every line the model writes has a voice to be spoken in.
 *  - **The subject is chosen here.** "Another episode" says nothing about what
 *    it covers; the show already knows what it is. The model is handed the
 *    brief and every subject already used, and picking the next one is the
 *    first part of the job. An owner may still name one.
 *  - **Two memories at two costs.** Every earlier subject in one line each (so
 *    episode twenty is not about episode two's subject again), and the full
 *    recap of only the last few (so it picks up where they left off).
 *
 * `title` and `recap` are the LAST keys of the JSON, because a model fills an
 * object in order: both are readings of the finished script.
 */

import type {
  GenerationFormat,
  GenerationSpeaker,
  GenerationSpeakerRole,
} from '../../../db/schema/podcastGeneration';
import type { PriorGeneratedEpisode } from '../../../db/podcasts/generations';

/** Who speaks in each format, in casting order. */
export const FORMAT_ROLES: Readonly<Record<GenerationFormat, readonly GenerationSpeakerRole[]>> = {
  podcast: ['host', 'co-host'],
  news: ['host', 'co-host'],
  debate: ['host', 'guest', 'guest'],
  interview: ['host', 'guest'],
  explainer: ['narrator'],
};

const FORMAT_GUIDANCE: Readonly<Record<GenerationFormat, string>> = {
  podcast:
    'Casual, friendly conversation between hosts. They share opinions, joke around and build on each other\'s points, with natural reactions like "Oh, that\'s interesting" or "Right, exactly."',
  news: 'Professional news broadcast. The anchor introduces stories and the reporter adds detail and analysis, at a brisk pace with brief back-and-forth commentary.',
  debate:
    'Two guests with opposing viewpoints, moderated by a neutral host. Each side presents arguments and rebuttals; the host keeps it civil and asks probing questions.',
  interview:
    'A host asks thoughtful questions and the guest gives in-depth answers. The host reacts naturally and follows up. Warm but informative.',
  explainer:
    'A single narrator explains the subject clearly and engagingly, with rhetorical questions, analogies and a conversational tone.',
};

/** Minutes of audio one episode aims for. */
export const TARGET_MINUTES = 3;
/** Every earlier subject is listed; this many recaps are sent in full. */
export const RECAP_WINDOW = 3;
/** The longest one-line subject kept per episode. */
const MAX_TOPIC_LENGTH = 300;
/** How much of one earlier subject the ledger carries. */
const LEDGER_TOPIC_CHARS = 140;
/** Owner-supplied source material is bounded so it cannot crowd out the rules. */
const MAX_NOTES_CHARS = 8000;
const MAX_TITLE_LENGTH = 200;

export function buildScriptSystemPrompt(
  format: GenerationFormat,
  speakers: readonly GenerationSpeaker[],
): string {
  const roster = speakers.map((speaker) => `- ${speaker.name} (${speaker.role})`).join('\n');
  const first = speakers[0]?.name ?? 'Host';
  const second = speakers[1]?.name ?? first;
  return `You write scripts for a podcast on Syra. They must sound like real spoken conversation, not written text read aloud.

## Format: ${format}
${FORMAT_GUIDANCE[format]}

## Speakers — use these EXACT names and no others
${roster}

Every segment's "speaker" is one of the names above, spelled exactly as written. Do not add, rename or merge speakers, and never use a role in place of a name.

## Writing
- Write SPOKEN dialogue: contractions, short sentences, natural reactions ("Yeah", "Exactly", "Hmm").
- Write only what a speaker says out loud: nothing in brackets, parentheses or asterisks, no stage directions, no sound effects and no music.
- Each segment is 1-4 sentences (15-60 words), never more than 80 words.
- About 150 words per minute of target duration.

## Output
Respond with ONLY valid JSON, no markdown, with the keys in this order:

{
  "topic": "One line naming what this episode covers",
  "description": "One or two sentences describing this episode for an episode list",
  "summary": "A paragraph summarising what this episode covers",
  "segments": [
    { "speaker": "${first}", "text": "Hey everyone, welcome back to..." },
    { "speaker": "${second}", "text": "Thanks..." },
    { "speaker": "${first}", "text": "So let's dive into..." }
  ],
  "recap": "Two or three sentences a LATER episode can read to remember what this one said",
  "title": "The name of this episode"
}

Write the segments first, then read them back: "recap" and "title" describe the episode you just wrote. The title comes from what the episode actually says, is six words or fewer, does not repeat the show's name, has no number, quotes or final full stop, and is in the script's language.`;
}

export interface ScriptUserPromptInput {
  readonly brief: string;
  readonly showTitle: string;
  /** What this episode covers, or `null` for the model to choose. */
  readonly topic: string | null;
  readonly episodeNumber: number;
  readonly notes: string | null;
  /** Earlier episodes, OLDEST first. */
  readonly previously: readonly PriorGeneratedEpisode[];
}

export function buildScriptUserPrompt(input: ScriptUserPromptInput): string {
  const covered = input.previously.filter(
    (episode): episode is PriorGeneratedEpisode & { topic: string } => episode.topic !== null,
  );
  const recaps = input.previously
    .filter(
      (episode): episode is PriorGeneratedEpisode & { recap: string } => episode.recap !== null,
    )
    .slice(-RECAP_WINDOW);

  const parts: string[] = [
    `This show is called "${input.showTitle}" and it is about: ${input.brief}`,
    '',
    `Write episode ${input.episodeNumber}.`,
  ];

  if (covered.length > 0) {
    parts.push(
      '',
      '## What this show has already covered',
      'One line per episode, oldest first. These subjects are used up: do not do any of them again.',
      '',
      ...covered.map(
        (episode) =>
          `Episode ${episode.episodeNumber}: ${episode.topic.slice(0, LEDGER_TOPIC_CHARS)}`,
      ),
    );
  }

  if (recaps.length > 0) {
    parts.push(
      '',
      '## Previously on this show',
      'Pick up where these left off, and refer back to them naturally, as a real host would.',
      '',
      ...recaps.map((episode) => `Episode ${episode.episodeNumber}: ${episode.recap}`),
    );
  } else if (input.episodeNumber === 1) {
    parts.push(
      '',
      'This is the FIRST episode: introduce the show and the speakers, and what listeners can expect.',
    );
  }

  if (input.topic === null) {
    parts.push(
      '',
      '## Choosing what this episode covers',
      'Nobody has said, so choosing is the first part of the job. Pick ONE subject that sits inside what this show is about, is none of the subjects already used (nor a rewording of one), and is narrow enough to do properly in the time. Put it in "topic", in one line.',
    );
  } else {
    parts.push(
      '',
      '## What this episode covers',
      input.topic,
      '',
      'The owner asked for this one, so cover it even if it overlaps something above. Put it in "topic" in your own one-line wording.',
    );
  }

  parts.push(
    '',
    `Target about ${TARGET_MINUTES} minutes, roughly ${TARGET_MINUTES * 150} words of dialogue.`,
  );

  if (input.notes !== null && input.notes.trim() !== '') {
    parts.push('', '## Source material', input.notes.slice(0, MAX_NOTES_CHARS));
  }

  return parts.join('\n');
}

export interface ParsedScript {
  /** The subject the model chose, or `null` when the request already named one. */
  readonly topic: string | null;
  readonly title: string | null;
  readonly description: string;
  readonly summary: string;
  readonly recap: string;
  readonly segments: ReadonlyArray<{ speaker: string; text: string }>;
}

/**
 * Read a script out of the model's reply, or answer `null` for a reply that is
 * not usable: not JSON, fewer than three lines, a line by somebody outside the
 * cast (it would have no voice), or no subject when the request named none (the
 * next episode could not be told not to repeat it). A missing title is not a
 * reason to refuse: the placeholder stands.
 */
export function parseScript(
  reply: string,
  castNames: ReadonlySet<string>,
  needsTopic: boolean,
): ParsedScript | null {
  const json = reply.match(/\{[\s\S]*\}/);
  if (!json) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json[0]) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!Array.isArray(parsed.segments)) return null;
  const segments = (parsed.segments as unknown[]).flatMap((segment) => {
    if (typeof segment !== 'object' || segment === null) return [];
    const { speaker, text } = segment as Record<string, unknown>;
    return typeof speaker === 'string' && typeof text === 'string' && text.trim() !== ''
      ? [{ speaker, text }]
      : [];
  });
  if (segments.length < 3) return null;
  if (segments.some((segment) => !castNames.has(segment.speaker))) return null;

  const firstLine = (typeof parsed.topic === 'string' ? parsed.topic : '').trim().split('\n')[0];
  const topic = firstLine?.trim() ? firstLine.trim().slice(0, MAX_TOPIC_LENGTH) : null;
  if (needsTopic && topic === null) return null;

  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  return {
    topic,
    title: cleanTitle(text(parsed.title)),
    description: text(parsed.description),
    summary: text(parsed.summary),
    recap: text(parsed.recap),
    segments,
  };
}

/**
 * A model's title, cleaned, or `null` for a reply that is an explanation or a
 * list of candidates rather than a name.
 */
export function cleanTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/^(?:episode title|title)\s*:\s*/i, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/\.+$/, '')
    .trim();
  if (title === '' || title.length > MAX_TITLE_LENGTH) return null;
  const line = title.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}
