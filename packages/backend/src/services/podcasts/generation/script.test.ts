import { describe, expect, it } from 'bun:test';
import { buildScriptSystemPrompt, buildScriptUserPrompt, cleanTitle, parseScript } from './script';

const CAST = new Set(['Eve', 'Rex']);

function reply(fields: Record<string, unknown>): string {
  return `Here you go:\n${JSON.stringify({
    topic: 'Why bees dance',
    description: 'd',
    summary: 's',
    segments: [
      { speaker: 'Eve', text: 'Welcome back.' },
      { speaker: 'Rex', text: 'Today, bees.' },
      { speaker: 'Eve', text: 'They dance.' },
    ],
    recap: 'We covered bee dances.',
    title: '"The Waggle Dance."',
    ...fields,
  })}`;
}

describe('parseScript', () => {
  it('reads a usable script out of a chatty reply', () => {
    const script = parseScript(reply({}), CAST, true);
    expect(script?.segments).toHaveLength(3);
    expect(script?.topic).toBe('Why bees dance');
    expect(script?.title).toBe('The Waggle Dance');
    expect(script?.recap).toBe('We covered bee dances.');
  });

  it('refuses a line by somebody outside the cast: it would have no voice', () => {
    const segments = [
      { speaker: 'Eve', text: 'a' },
      { speaker: 'Rex', text: 'b' },
      { speaker: 'Marcus', text: 'c' },
    ];
    expect(parseScript(reply({ segments }), CAST, true)).toBeNull();
  });

  it('refuses fewer than three spoken lines', () => {
    const segments = [{ speaker: 'Eve', text: 'a' }];
    expect(parseScript(reply({ segments }), CAST, true)).toBeNull();
  });

  it('needs a subject only when the request named none', () => {
    expect(parseScript(reply({ topic: '' }), CAST, true)).toBeNull();
    expect(parseScript(reply({ topic: '' }), CAST, false)?.topic).toBeNull();
  });

  it('keeps the placeholder when the title is not a title', () => {
    expect(parseScript(reply({ title: 'x'.repeat(300) }), CAST, true)?.title).toBeNull();
  });

  it('answers null for no JSON at all', () => {
    expect(parseScript('I cannot help with that.', CAST, true)).toBeNull();
  });
});

describe('cleanTitle', () => {
  it('strips what models add around a title', () => {
    expect(cleanTitle('Title: “Bees, Explained.”')).toBe('Bees, Explained');
    expect(cleanTitle('Is anything real?')).toBe('Is anything real?');
    expect(cleanTitle('One\nTwo')).toBe('One');
    expect(cleanTitle('   ')).toBeNull();
  });
});

describe('prompts', () => {
  it('names the cast exactly, and only the cast', () => {
    const prompt = buildScriptSystemPrompt('podcast', [
      { name: 'Eve', voiceId: 'eve', role: 'host' },
      { name: 'Rex', voiceId: 'rex', role: 'co-host' },
    ]);
    expect(prompt).toContain('- Eve (host)');
    expect(prompt).toContain('- Rex (co-host)');
    expect(prompt).toContain('"speaker": "Eve"');
  });

  it('lists every earlier subject, and recaps only the last few', () => {
    const previously = [1, 2, 3, 4, 5].map((episodeNumber) => ({
      episodeNumber,
      topic: `subject ${episodeNumber}`,
      recap: `recap ${episodeNumber}`,
    }));
    const prompt = buildScriptUserPrompt({
      brief: 'Bees.',
      showTitle: 'Hive',
      topic: null,
      episodeNumber: 6,
      notes: null,
      previously,
    });
    for (const n of [1, 2, 3, 4, 5]) expect(prompt).toContain(`Episode ${n}: subject ${n}`);
    expect(prompt).not.toContain('recap 2');
    expect(prompt).toContain('Episode 5: recap 5');
    expect(prompt).toContain('choosing is the first part of the job');
  });

  it('gives a requested subject instead of asking for one', () => {
    const prompt = buildScriptUserPrompt({
      brief: 'Bees.',
      showTitle: 'Hive',
      topic: 'Queens',
      episodeNumber: 1,
      notes: null,
      previously: [],
    });
    expect(prompt).toContain('## What this episode covers\nQueens');
    expect(prompt).toContain('FIRST episode');
  });
});
