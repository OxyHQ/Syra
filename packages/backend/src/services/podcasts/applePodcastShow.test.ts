import { describe, expect, it } from 'bun:test';
import { resolveAppleShow, type AppleShowDeps } from './applePodcastShow';

function deps(overrides: Partial<AppleShowDeps> = {}): AppleShowDeps & { imported: string[] } {
  const imported: string[] = [];
  return {
    imported,
    lookupFeedUrl: async () => 'https://feeds.example/show.xml',
    importFeed: async (feedUrl) => {
      imported.push(feedUrl);
      return { podcast: { id: 'show_1' } };
    },
    ...overrides,
  };
}

describe('resolveAppleShow', () => {
  it('imports the feed Apple names and answers with the show', async () => {
    const d = deps();
    expect(await resolveAppleShow('1234567890', d)).toEqual({ podcastId: 'show_1' });
    expect(d.imported).toEqual(['https://feeds.example/show.xml']);
  });

  it('answers not-found, without importing, when Apple has no such podcast', async () => {
    const d = deps({ lookupFeedUrl: async () => null });
    expect(await resolveAppleShow('1234567890', d)).toEqual({ notFound: true });
    expect(d.imported).toEqual([]);
  });

  it('refuses a collection id that is not numeric, before asking Apple', async () => {
    let asked = false;
    const d = deps({
      lookupFeedUrl: async () => {
        asked = true;
        return 'https://feeds.example/show.xml';
      },
    });
    await expect(resolveAppleShow('../etc', d)).rejects.toThrow(TypeError);
    expect(asked).toBe(false);
  });
});
