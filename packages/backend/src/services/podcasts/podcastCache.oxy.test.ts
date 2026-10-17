import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { installFakeOxyFiles, resetOxyFiles, type FakeOxyFiles } from '../../test/fakeOxyFiles';
import { getDb } from '../../db/postgres';
import { getEpisodeAudio } from '../../controllers/podcastAudio.controller';
import { cacheEpisode } from './podcastCache';

/**
 * A mirrored RSS episode's enclosure is cached BY OXY (ADR 0043 stage 4c): an
 * import by URL, Syra's own private file, referenced as the episode's audio —
 * and `/audio`, the enclosure every podcast client fetches, redirects to it.
 */

let fake: FakeOxyFiles;

beforeAll(connectDb);
beforeEach(() => {
  fake = installFakeOxyFiles();
  process.env.OXY_AUDIO = 'dual';
});
afterEach(async () => {
  delete process.env.OXY_AUDIO;
  resetOxyFiles();
  await clearDb();
});
afterAll(disconnectDb);

const EPISODE_ID = '01a00000-0000-7000-8000-000000000001';

async function seedFeedEpisode(): Promise<void> {
  await getDb().execute(sql`
    insert into podcasts (id, title, source, visibility) values ('feed-1', 'F', 'rss', 'public')
  `);
  await getDb().execute(sql`
    insert into episodes (id, podcast_id, podcast_title, title, guid, pub_date, source, enclosure_url)
    values (${EPISODE_ID}, 'feed-1', 'F', 'E', 'g', now(), 'rss', 'https://feeds.test/ep.mp3')
  `);
  fake.remote.set('https://feeds.test/ep.mp3', {
    bytes: Buffer.from('enclosure'),
    mime: 'audio/mpeg',
  });
}

describe('cacheEpisode with OXY_AUDIO on', () => {
  it("imports the enclosure into Oxy as Syra's private, referenced file", async () => {
    await seedFeedEpisode();
    const cached = await cacheEpisode(EPISODE_ID);
    expect(cached?.store).toBe('oxy');
    const fileId = (cached as { fileId: string }).fileId;
    expect(fake.files.get(fileId)).toMatchObject({ visibility: 'private', mime: 'audio/mpeg' });
    expect(fake.hasReference(fileId, 'episode_audio', EPISODE_ID)).toBe(true);

    const [row] = await getDb().execute<{ audio_file_id: string; cache_status: string }>(
      sql`select audio_file_id, cache_status from episodes where id = ${EPISODE_ID}`,
    );
    expect(row).toEqual({ audio_file_id: fileId, cache_status: 'cached' });

    // Idempotent: a second call imports nothing.
    expect(await cacheEpisode(EPISODE_ID)).toEqual({ store: 'oxy', fileId });
    expect(fake.calls.filter((call) => call.method === 'importAppFile')).toHaveLength(1);
  });

  it("redirects the episode's /audio to the original's short-lived Oxy URL", async () => {
    await seedFeedEpisode();
    const cached = (await cacheEpisode(EPISODE_ID)) as { fileId: string };

    let redirected: { status: number; url: string } | undefined;
    const res = {
      set: () => res,
      status: () => res,
      json: () => res,
      redirect: (status: number, url: string) => {
        redirected = { status, url };
      },
    };
    await getEpisodeAudio(
      { params: { id: EPISODE_ID }, query: {}, headers: {} } as unknown as AuthRequest,
      res as unknown as Response,
    );
    expect(redirected).toEqual({
      status: 302,
      url: `https://download.oxy.test/${cached.fileId}?sig=x`,
    });
  });
});
