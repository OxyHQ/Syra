import { api, publicApi } from '@/utils/api';
import { podcastService } from '@/services/podcastService';
import { episodeService } from '@/services/episodeService';

/**
 * WHICH CLIENT each podcast read goes through, which is the whole of one bug.
 *
 * A creator opened their own private show from their own library and got a 404.
 * The server was right to send it: `viewerCanReadShowFilter` reads a private
 * show for its OWNER and for nobody else, and the request arrived with no
 * bearer, so there was no owner to compare against. The show page read through
 * the unauthenticated client. Omitting the identity is not a neutral default on
 * a viewer-scoped route — it is a claim to be a stranger.
 *
 * These assertions are on the CLIENT rather than on a response, because a
 * response-shaped test passes under both clients: the public show that every
 * fixture uses is readable either way. The only observable difference between
 * the bug and the fix is which client carries the call.
 *
 * The discovery reads are pinned to the public client in the same file, so a
 * later "just make everything authenticated" cannot quietly follow: browse and
 * search serve only listable shows, no identity changes their answer, and
 * keying them per-viewer would fragment a cache that is meant to be shared.
 */

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn(async () => ({ data: { data: null } })) },
  publicApi: { get: jest.fn(async () => ({ data: { data: null } })) },
}));

const mockApiGet = api.get as jest.MockedFunction<typeof api.get>;
const mockPublicGet = publicApi.get as jest.MockedFunction<typeof publicApi.get>;

/** Every read here parses its response; the shape is not what is under test. */
const ignoreParseFailure = (run: () => Promise<unknown>) => run().catch(() => undefined);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reads addressed by id carry the viewer', () => {
  it('reads one show through the authenticated client', async () => {
    await ignoreParseFailure(() => podcastService.getPodcast('show-1'));

    expect(mockApiGet).toHaveBeenCalledWith('/podcasts/show-1');
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads a show episode list through the authenticated client', async () => {
    await ignoreParseFailure(() => podcastService.getPodcastEpisodes('show-1', { limit: 50 }));

    expect(mockApiGet).toHaveBeenCalledWith('/podcasts/show-1/episodes', { limit: 50 });
    expect(mockPublicGet).not.toHaveBeenCalled();
  });

  it('reads one episode through the authenticated client', async () => {
    await ignoreParseFailure(() => episodeService.getEpisode('episode-1'));

    expect(mockApiGet).toHaveBeenCalledWith('/episodes/episode-1');
    expect(mockPublicGet).not.toHaveBeenCalled();
  });
});

describe('discovery stays anonymous, and shared', () => {
  it('searches through the public client', async () => {
    await ignoreParseFailure(() => podcastService.searchPodcasts('musk'));

    expect(mockPublicGet).toHaveBeenCalled();
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('browses through the public client', async () => {
    await ignoreParseFailure(() => podcastService.browsePodcasts({ sort: 'recent' }));

    expect(mockPublicGet).toHaveBeenCalled();
    expect(mockApiGet).not.toHaveBeenCalled();
  });
});
