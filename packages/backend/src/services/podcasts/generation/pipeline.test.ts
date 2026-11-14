/**
 * A generated episode end to end against a real Postgres: the request
 * reserves it, the pipeline writes and voices it, and it becomes the show's
 * source audio. Kaana, ffmpeg, storage and ingest are the four seams faked,
 * each through the deps the services take — no module mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxy.so/db';
import { clearDb, connectDb, disconnectDb } from '../../../test/postgres';
import { getDb } from '../../../db/postgres';
import { episodes, podcasts } from '../../../db/schema/podcasts';
import {
  episodeGenerations,
  podcastGenerationProfiles,
} from '../../../db/schema/podcastGeneration';
import { findPodcastForOwner } from '../../../db/podcasts/podcasts';
import type { GenerationKaana } from './kaana';
import { runEpisodeGeneration, type GenerationDeps } from './pipeline';
import {
  MAX_ACTIVE_GENERATIONS,
  requestEpisodeGeneration,
  type GenerationRequestDeps,
} from './request';

const OWNER = '6981c9178fcdefaf81988ffb';

const SPEECH_MODEL = {
  modelId: 'acme/speech',
  capabilities: { apiFormats: ['audio_speech'] },
  audio: {
    voices: [
      { id: 'a', name: 'Ara', languages: [], gender: 'female' },
      { id: 'r', name: 'Rex', languages: [], gender: 'male' },
    ],
    languages: [],
    audioFormats: { input: [], output: ['audio/mpeg'] },
    maxInputCharacters: 1000,
  },
};

function script(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    topic: 'Why bees dance',
    description: 'Bees, dancing.',
    summary: 'All about the waggle.',
    segments: [
      { speaker: 'Ara', text: 'Welcome to the hive.' },
      { speaker: 'Rex', text: 'Today we talk about dancing bees.' },
      { speaker: 'Ara', text: 'It is all in the waggle.' },
    ],
    recap: 'We explained the waggle dance.',
    title: 'The Waggle',
    ...fields,
  });
}

interface FakeKaana {
  client: GenerationKaana;
  spoken: string[];
  disposed: number;
}

function fakeKaana(options: { reply?: string; speechFails?: boolean } = {}): FakeKaana {
  const fake: FakeKaana = { spoken: [], disposed: 0, client: undefined as never };
  fake.client = {
    models: {
      list: async () => [SPEECH_MODEL],
      get: async () => SPEECH_MODEL,
    },
    responses: {
      create: async () => ({
        output: [
          { role: 'assistant', content: [{ type: 'text', text: options.reply ?? script() }] },
        ],
      }),
    },
    audio: {
      speech: async (request: { input: string; voice: string }) => {
        if (options.speechFails) throw new Error('speech down');
        fake.spoken.push(`${request.voice}:${request.input}`);
        return { audio: new TextEncoder().encode(request.input) };
      },
    },
    dispose: () => {
      fake.disposed += 1;
    },
  } as unknown as GenerationKaana;
  return fake;
}

const enqueued: string[] = [];

function requestDeps(kaana: FakeKaana): GenerationRequestDeps {
  return {
    kaanaFor: async () => kaana.client,
    enqueue: async (episodeId) => {
      enqueued.push(episodeId);
    },
  };
}

const stored: { key: string; bytes: number }[] = [];
const ingested: string[] = [];

function pipelineDeps(kaana: FakeKaana): GenerationDeps {
  return {
    kaanaFor: async () => kaana.client,
    assemble: async (lines) => ({ audio: Buffer.concat(lines), durationSec: 181 }),
    storeSource: async (key, body) => {
      stored.push({ key, bytes: Buffer.isBuffer(body) ? body.length : 0 });
    },
    ingest: async (episodeId) => {
      ingested.push(episodeId);
      await getDb().update(episodes).set({ status: 'ready' }).where(eq(episodes.id, episodeId));
    },
  };
}

async function insertShow(description: string | null = 'A show about bees.'): Promise<string> {
  const id = uuidv7();
  await getDb()
    .insert(podcasts)
    .values({
      id,
      title: 'Hive',
      description,
      source: 'syra',
      status: 'active',
      visibility: 'private',
      ownerOxyUserId: OWNER,
      feedUrl: `https://feeds.example.invalid/${id}.xml`,
    });
  return id;
}

async function ownedShow(id: string) {
  const show = await findPodcastForOwner(id, OWNER);
  if (!show) throw new Error('fixture show missing');
  return show;
}

const noTask = <T>(_episodeId: string, write: (oxyTaskId: string | null) => Promise<T>) =>
  write(null);

beforeAll(async () => {
  await connectDb();
});

beforeEach(async () => {
  await clearDb();
  enqueued.length = 0;
  stored.length = 0;
  ingested.length = 0;
});

afterAll(async () => {
  await disconnectDb();
});

describe('requestEpisodeGeneration', () => {
  it('casts the show from the catalogue, reserves episode 1 and queues it', async () => {
    const kaana = fakeKaana();
    const show = await ownedShow(await insertShow());
    const result = await requestEpisodeGeneration({
      show,
      requesterId: OWNER,
      request: {},
      fileTask: noTask,
      deps: requestDeps(kaana),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.episode.episodeNumber).toBe(1);
    expect(result.episode.status).toBe('processing');
    expect(result.episode.aiGenerated).toBe(true);
    expect(enqueued).toEqual([result.episode.id]);
    const [profile] = await getDb().select().from(podcastGenerationProfiles);
    expect(profile?.brief).toBe('A show about bees.');
    expect(profile?.speechModel).toBe('acme/speech');
    expect(profile?.speakers.map((speaker) => speaker.name)).toEqual(['Ara', 'Rex']);
    expect(kaana.disposed).toBe(1);
  });

  it("numbers episodes after the show's highest", async () => {
    const kaana = fakeKaana();
    const show = await ownedShow(await insertShow());
    const args = { show, requesterId: OWNER, fileTask: noTask, deps: requestDeps(kaana) };
    await requestEpisodeGeneration({ ...args, request: {} });
    const second = await requestEpisodeGeneration({ ...args, request: { topic: 'Queens' } });
    expect(second.ok && second.episode.episodeNumber).toBe(2);
    expect(second.ok && second.generation.topic).toBe('Queens');
  });

  it('asks for a brief when the show has neither one nor a description', async () => {
    const show = await ownedShow(await insertShow(null));
    const result = await requestEpisodeGeneration({
      show,
      requesterId: OWNER,
      request: {},
      fileTask: noTask,
      deps: requestDeps(fakeKaana()),
    });
    expect(result).toMatchObject({ ok: false, code: 'brief_required' });
    expect(await getDb().select().from(episodes)).toHaveLength(0);
  });

  it(`refuses a person with ${MAX_ACTIVE_GENERATIONS} generations running`, async () => {
    const kaana = fakeKaana();
    const show = await ownedShow(await insertShow());
    const args = {
      show,
      requesterId: OWNER,
      fileTask: noTask,
      deps: requestDeps(kaana),
      request: {},
    };
    for (let i = 0; i < MAX_ACTIVE_GENERATIONS; i += 1) {
      expect((await requestEpisodeGeneration(args)).ok).toBe(true);
    }
    expect(await requestEpisodeGeneration(args)).toMatchObject({
      ok: false,
      code: 'too_many_running',
    });
  });

  it('answers a repeated idempotency key with the first generation', async () => {
    const kaana = fakeKaana();
    const show = await ownedShow(await insertShow());
    const args = {
      show,
      requesterId: OWNER,
      fileTask: noTask,
      deps: requestDeps(kaana),
      request: { idempotencyKey: 'agent-request-1' },
    };
    const first = await requestEpisodeGeneration(args);
    const again = await requestEpisodeGeneration(args);
    expect(again.ok && again.replayed).toBe(true);
    expect(again.ok && first.ok && again.episode.id === first.episode.id).toBe(true);
    expect(enqueued).toHaveLength(1);
  });

  it('refuses a show not hosted on Syra', async () => {
    const id = await insertShow();
    await getDb().update(podcasts).set({ source: 'rss' }).where(eq(podcasts.id, id));
    const result = await requestEpisodeGeneration({
      show: await ownedShow(id),
      requesterId: OWNER,
      request: {},
      fileTask: noTask,
      deps: requestDeps(fakeKaana()),
    });
    expect(result).toMatchObject({ ok: false, code: 'not_generatable' });
  });
});

describe('runEpisodeGeneration', () => {
  async function requested(kaana: FakeKaana) {
    const show = await ownedShow(await insertShow());
    const result = await requestEpisodeGeneration({
      show,
      requesterId: OWNER,
      request: {},
      fileTask: noTask,
      deps: requestDeps(kaana),
    });
    if (!result.ok) throw new Error('request refused');
    return result.episode;
  }

  it("writes, voices and publishes the episode as the show's source audio", async () => {
    const kaana = fakeKaana();
    const episode = await requested(kaana);
    await runEpisodeGeneration(episode.id, pipelineDeps(kaana));

    const [generation] = await getDb()
      .select()
      .from(episodeGenerations)
      .where(eq(episodeGenerations.episodeId, episode.id));
    expect(generation).toMatchObject({
      status: 'completed',
      progress: 100,
      topic: 'Why bees dance',
      recap: 'We explained the waggle dance.',
      error: null,
    });
    const [row] = await getDb().select().from(episodes).where(eq(episodes.id, episode.id));
    expect(row).toMatchObject({
      title: 'The Waggle',
      duration: 181,
      audioSourceFormat: 'mp3',
      status: 'ready',
    });
    expect(kaana.spoken).toEqual([
      'a:Welcome to the hive.',
      'r:Today we talk about dancing bees.',
      'a:It is all in the waggle.',
    ]);
    expect(stored).toEqual([
      { key: expect.stringContaining(episode.id), bytes: expect.any(Number) },
    ]);
    expect(ingested).toEqual([episode.id]);
  });

  it('records a failure the owner can read and marks the episode failed', async () => {
    const kaana = fakeKaana({ speechFails: true });
    const episode = await requested(kaana);
    await runEpisodeGeneration(episode.id, pipelineDeps(kaana));

    const [generation] = await getDb()
      .select()
      .from(episodeGenerations)
      .where(eq(episodeGenerations.episodeId, episode.id));
    expect(generation?.status).toBe('failed');
    expect(generation?.error).toBe('No audio could be generated for this episode.');
    expect(generation?.segments.every((segment) => segment.renderFailed)).toBe(true);
    const [row] = await getDb().select().from(episodes).where(eq(episodes.id, episode.id));
    expect(row?.status).toBe('failed');
    expect(stored).toHaveLength(0);
    expect(kaana.disposed).toBeGreaterThan(0);
  });

  it('fails after two unusable script replies, without voicing anything', async () => {
    const kaana = fakeKaana({ reply: 'Sorry, I cannot.' });
    const episode = await requested(kaana);
    await runEpisodeGeneration(episode.id, pipelineDeps(kaana));
    const [generation] = await getDb()
      .select()
      .from(episodeGenerations)
      .where(eq(episodeGenerations.episodeId, episode.id));
    expect(generation?.status).toBe('failed');
    expect(kaana.spoken).toHaveLength(0);
  });

  it('does nothing for a job delivered again after it finished', async () => {
    const kaana = fakeKaana();
    const episode = await requested(kaana);
    await runEpisodeGeneration(episode.id, pipelineDeps(kaana));
    const spoken = kaana.spoken.length;
    await runEpisodeGeneration(episode.id, pipelineDeps(kaana));
    expect(kaana.spoken).toHaveLength(spoken);
    expect(ingested).toHaveLength(1);
  });
});
