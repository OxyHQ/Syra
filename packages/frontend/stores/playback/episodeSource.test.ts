import type { Episode } from '@syra/shared-types';
import { episodeNeedsResolvedSource } from './episodeSource';

/**
 * The decision the `NotSupportedError` lived in.
 *
 * The old predicate asked "does this episode have an HLS ladder", which is
 * false for every episode of a PRIVATE show — the transcode is skipped by
 * design — so the player reached for the unauthenticated `/audio` URL, the
 * server answered 404 to the one person entitled to hear it, and the browser
 * reported that no supported source was found.
 *
 * The first row below is that episode. It is the case a ladder-based test can
 * never express, which is why the ladder is not in the predicate at all.
 */

function episode(overrides: Partial<Episode>): Episode {
  return {
    id: 'episode-1',
    podcastId: 'show-1',
    title: 'An Episode',
    source: 'syra',
    status: 'ready',
    ...overrides,
  } as Episode;
}

describe('episodeNeedsResolvedSource', () => {
  it('resolves a Syra-hosted episode with NO ladder — every private episode', () => {
    expect(episodeNeedsResolvedSource(episode({ hlsMasterKey: undefined }), true)).toBe(true);
  });

  it('resolves one that does have a ladder, as it always did', () => {
    const withLadder = episode({ hlsMasterKey: 'hls/show-1/episode-1/master.m3u8' } as Partial<Episode>);

    expect(episodeNeedsResolvedSource(withLadder, true)).toBe(true);
  });

  it('leaves an rss episode on the public proxy, which is its enclosure', () => {
    expect(episodeNeedsResolvedSource(episode({ source: 'rss' }), true)).toBe(false);
  });

  it('leaves a signed-out listener on the public proxy, having nothing to attach', () => {
    expect(episodeNeedsResolvedSource(episode({}), false)).toBe(false);
  });

  it('does not resolve an episode that is not ready to play', () => {
    expect(episodeNeedsResolvedSource(episode({ status: 'processing' }), true)).toBe(false);
  });
});
