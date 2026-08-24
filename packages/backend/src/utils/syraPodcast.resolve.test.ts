/**
 * `resolvePodcastEpisode` turns a Syra episode id into something a live room
 * can actually stream. It has to answer for THREE shapes of episode, and until
 * the SDK modelled Syra's own content it only knew one of them.
 *
 * An RSS mirror carries an absolute `enclosureUrl`. A Syra-hosted episode
 * leaves that null and carries `audioSource` instead. A drafted episode —
 * created by the ingest draft endpoint and waiting for a worker to deliver
 * audio — carries neither, and is a real, listable episode with nothing to
 * play.
 *
 * The honest note on evidence: the Syra-hosted case could not have been caught
 * by a test against the previous code, because that code does not COMPILE once
 * `enclosureUrl` is optional. The type system is the gate there. These cases
 * pin the behaviour going forward, and the drafted case is a genuine runtime
 * decision the compiler has no opinion about.
 */
import { describe, expect, it, spyOn } from 'bun:test';

const BASE = 'https://syra.test';
process.env.SYRA_API_URL = BASE;

const { resolvePodcastEpisode, syraClient } = await import('./syraPodcast');

/**
 * A real Redis may be running, and successful resolves ARE cached. Reusing a
 * fixed id would mean the second run of this file answered from the cache
 * without calling the resolver at all — passing whether or not the code still
 * works. A per-run suffix keeps every case a genuine cache MISS.
 */
const run = process.hrtime.bigint().toString(36);
const uid = (name: string) => `${name}-${run}`;

/** Only `id`, `podcastId` and `title` are required, so no casts are needed. */
const episode = (over: Record<string, unknown>) => ({
  id: 'ep',
  podcastId: 'show',
  title: 'An episode',
  ...over,
});

describe('resolvePodcastEpisode', () => {
  it('resolves a SYRA-HOSTED episode through audioSource, which has no enclosure', async () => {
    const spy = spyOn(syraClient, 'getEpisode').mockResolvedValue(
      episode({ id: uid('syra'), audioSource: { url: `/api/podcasts/episodes/${uid('syra')}/audio` } })
    );
    const got = await resolvePodcastEpisode(uid('syra'));
    spy.mockRestore();

    expect(got.status).toBe('ok');
    if (got.status !== 'ok') return;
    expect(got.episode.audioUrl).toBe(`${BASE}/api/podcasts/episodes/${uid('syra')}/audio`);
  });

  it('leaves an RSS mirror’s absolute enclosure untouched', async () => {
    const spy = spyOn(syraClient, 'getEpisode').mockResolvedValue(
      episode({ id: uid('rss'), enclosureUrl: 'https://elsewhere.example/ep.mp3' })
    );
    const got = await resolvePodcastEpisode(uid('rss'));
    spy.mockRestore();

    expect(got.status).toBe('ok');
    if (got.status !== 'ok') return;
    expect(got.episode.audioUrl).toBe('https://elsewhere.example/ep.mp3');
  });

  it('refuses a DRAFTED episode, which exists but has nothing to play', async () => {
    const spy = spyOn(syraClient, 'getEpisode').mockResolvedValue(
      episode({ id: uid('draft'), status: 'processing' })
    );
    const got = await resolvePodcastEpisode(uid('draft'));
    spy.mockRestore();

    // not_found (404), never unavailable (503): a draft is not a Syra outage,
    // and 503 would both misreport the cause and invite a retry that cannot
    // succeed until someone ingests the audio.
    expect(got.status).toBe('not_found');
  });
});
