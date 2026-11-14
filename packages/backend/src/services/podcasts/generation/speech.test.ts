import { describe, expect, it } from 'bun:test';
import type { KaanaModel } from './kaana';
import { castFromCatalogue, speakableText, splitForSpeech } from './speech';

type Voice = { id: string; name: string; gender?: 'female' | 'male' | 'neutral' };

function speechModel(modelId: string, voices: Voice[], formats = ['audio/mpeg']): KaanaModel {
  return {
    modelId,
    capabilities: { apiFormats: ['audio_speech'] },
    audio: {
      voices: voices.map((voice) => ({ languages: [], ...voice })),
      languages: [],
      audioFormats: { input: [], output: formats },
    },
  } as unknown as KaanaModel;
}

const TEXT_MODEL = {
  modelId: 'acme/text',
  capabilities: { apiFormats: ['responses'] },
} as unknown as KaanaModel;

describe('castFromCatalogue', () => {
  it('casts from the first speech model with enough voices, in distinct voices', () => {
    const cast = castFromCatalogue(
      [
        TEXT_MODEL,
        speechModel('acme/one-voice', [{ id: 'solo', name: 'Solo' }]),
        speechModel('acme/speech', [
          { id: 'a', name: 'Ara', gender: 'female' },
          { id: 'e', name: 'Eve', gender: 'female' },
          { id: 'r', name: 'Rex', gender: 'male' },
        ]),
      ],
      'podcast',
    );
    expect(cast?.speechModel).toBe('acme/speech');
    // Alternates gender where the catalogue says it.
    expect(cast?.speakers).toEqual([
      { name: 'Ara', voiceId: 'a', role: 'host' },
      { name: 'Rex', voiceId: 'r', role: 'co-host' },
    ]);
  });

  it('casts one narrator for an explainer', () => {
    const cast = castFromCatalogue(
      [speechModel('acme/one-voice', [{ id: 'solo', name: 'Solo' }])],
      'explainer',
    );
    expect(cast?.speakers).toEqual([{ name: 'Solo', voiceId: 'solo', role: 'narrator' }]);
  });

  it('answers null when nothing speaks MP3 with enough voices', () => {
    expect(castFromCatalogue([TEXT_MODEL], 'podcast')).toBeNull();
    expect(
      castFromCatalogue(
        [
          speechModel(
            'acme/wav',
            [
              { id: 'a', name: 'A' },
              { id: 'b', name: 'B' },
            ],
            ['audio/wav'],
          ),
        ],
        'podcast',
      ),
    ).toBeNull();
  });
});

describe('speakableText', () => {
  it('removes stage directions and keeps the words', () => {
    expect(speakableText('Well [laughs] that is (sighs) *true* .')).toBe('Well that is.');
    expect(speakableText('[music]')).toBe('');
  });
});

describe('splitForSpeech', () => {
  it('splits on sentences and never exceeds the limit', () => {
    const text = 'One two three. Four five six. Seven eight nine.';
    const pieces = splitForSpeech(text, 20);
    expect(pieces.every((piece) => piece.length <= 20)).toBe(true);
    expect(pieces.join(' ')).toBe(text);
  });

  it('cuts a word longer than the limit', () => {
    expect(splitForSpeech('x'.repeat(25), 10).map((piece) => piece.length)).toEqual([10, 10, 5]);
  });
});
