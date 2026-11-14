/**
 * Who speaks, and what they can say: the cast is cast from Kaana's catalogue,
 * and every line is reduced to what a speech model reads.
 *
 * No voice, model or provider is named in this file. Kaana publishes, per
 * speech model, the voices it speaks in (with their names and, where reviewed,
 * gender) and the longest text one request may carry; a show is cast from the
 * first speech model Syra's catalogue lists that has enough voices, and the
 * on-air names ARE those voices' names.
 */

import type { GenerationFormat, GenerationSpeaker } from '../../../db/schema/podcastGeneration';
import type { KaanaModel } from './kaana';
import { FORMAT_ROLES } from './script';

export interface SpeechCast {
  readonly speechModel: string;
  readonly speakers: GenerationSpeaker[];
}

function speaksMp3(model: KaanaModel): boolean {
  return (
    (model.capabilities.apiFormats ?? []).includes('audio_speech') &&
    (model.audio?.audioFormats.output ?? []).includes('audio/mpeg')
  );
}

/**
 * Cast a show of `format` from the catalogue, or `null` when no speech model
 * has enough voices. Distinct voices, alternating gender where the catalogue
 * says it, in the catalogue's own order.
 */
export function castFromCatalogue(
  models: readonly KaanaModel[],
  format: GenerationFormat,
): SpeechCast | null {
  const roles = FORMAT_ROLES[format];
  const model = models.find(
    (candidate) => speaksMp3(candidate) && (candidate.audio?.voices.length ?? 0) >= roles.length,
  );
  if (!model?.audio) return null;

  const available = [...model.audio.voices];
  const speakers: GenerationSpeaker[] = [];
  for (const role of roles) {
    const previous = speakers.at(-1);
    const previousGender = previous
      ? model.audio.voices.find((voice) => voice.id === previous.voiceId)?.gender
      : undefined;
    const index = Math.max(
      0,
      available.findIndex(
        (voice) =>
          previousGender === undefined ||
          voice.gender === undefined ||
          voice.gender !== previousGender,
      ),
    );
    const [voice] = available.splice(index, 1);
    if (!voice) return null;
    speakers.push({ name: voice.name, voiceId: voice.id, role });
  }
  // Two speakers called the same are one speaker to the script.
  return new Set(speakers.map((speaker) => speaker.name)).size === speakers.length
    ? { speechModel: model.modelId, speakers }
    : null;
}

/**
 * A line as it is spoken: anything in brackets or asterisks removed (the
 * prompt asks for none; a model writes some anyway), spacing tidied, and empty
 * when nothing pronounceable is left.
 */
export function speakableText(text: string): string {
  const spoken = text
    .replace(/\[[^\]\n]*\]|\([^)\n]*\)|\*[^*\n]*\*|[[\]*]/g, '')
    .replace(/[ \t]+([,.;:!?…])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[\s,.;:…]+/, '')
    .trim();
  return /[\p{L}\p{N}]/u.test(spoken) ? spoken : '';
}

/**
 * Split a line longer than one speech request may carry, on sentence
 * boundaries, then on words, never inside a surrogate pair.
 */
export function splitForSpeech(text: string, max: number): string[] {
  if (text.length <= max) return text.length === 0 ? [] : [text];

  const pieces: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.trim() !== '') pieces.push(current.trim());
    current = '';
  };
  const append = (part: string): void => {
    if (current.length + part.length + 1 > max) flush();
    current = current === '' ? part : `${current} ${part}`;
  };

  for (const sentence of text.split(/(?<=[.!?…。！？])\s+/u)) {
    if (sentence.length <= max) {
      append(sentence);
      continue;
    }
    for (const word of sentence.split(/\s+/u)) {
      let rest = word;
      while (rest.length > max) {
        let cut = max;
        const code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        append(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      if (rest !== '') append(rest);
    }
  }
  flush();
  return pieces;
}
