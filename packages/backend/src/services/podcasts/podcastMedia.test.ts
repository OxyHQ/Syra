import { describe, it, expect, afterEach } from 'bun:test';
import type { CatalogImageContext } from '../catalog/catalogImageAssets';
import { setCatalogImageMirrorImplementationForTests } from '../catalog/catalogImageAssets';
import { rehostPodcastImage } from './podcastMedia';

// Reset the shared mirror implementation back to the real one after each test so
// other suites (which install their own mock in setup) are unaffected.
afterEach(() => setCatalogImageMirrorImplementationForTests());

const SIZES = {
  large: { id: 'img1', url: '/api/images/img1', width: 640, height: 640 },
};

describe('rehostPodcastImage', () => {
  it('maps the catalog mirror asset to a RehostedImage and forwards podcast context', async () => {
    let received: CatalogImageContext | undefined;
    setCatalogImageMirrorImplementationForTests(async (images, context) => {
      received = context;
      expect(images?.[0]?.url).toBe('https://cdn.example/cover.jpg');
      return {
        imageId: 'img1',
        imageSizes: SIZES,
        primaryColor: '#112233',
        secondaryColor: '#445566',
        sourceUrlHash: 'u',
        sourceContentHash: 'c',
      };
    });

    const result = await rehostPodcastImage('https://cdn.example/cover.jpg', {
      source: 'rss',
      entityType: 'podcast',
      externalId: 'guid-1',
    });

    expect(received?.provider).toBe('rss');
    expect(received?.entityType).toBe('podcast');
    expect(received?.externalId).toBe('guid-1');
    expect(result).toEqual({
      image: 'img1',
      imageSizes: SIZES,
      primaryColor: '#112233',
      secondaryColor: '#445566',
    });
  });

  it('only forwards existingImageId when it is a valid ObjectId', async () => {
    let received: CatalogImageContext | undefined;
    setCatalogImageMirrorImplementationForTests(async (_images, context) => {
      received = context;
      return undefined;
    });

    await rehostPodcastImage('https://cdn.example/c.jpg', {
      source: 'syra',
      entityType: 'episode',
      externalId: 'g',
      existingImageId: 'not-an-objectid',
      existingImageSizes: SIZES,
    });
    expect(received?.entityType).toBe('episode');
    expect(received?.provider).toBe('syra');
    expect(received?.existingImageId).toBeUndefined();
    expect(received?.existingImageSizes).toBeUndefined();

    await rehostPodcastImage('https://cdn.example/c.jpg', {
      source: 'syra',
      entityType: 'episode',
      externalId: 'g',
      existingImageId: '5f9d88b9c1f4e2a3b4c5d6e7',
      existingImageSizes: SIZES,
    });
    expect(received?.existingImageId).toBe('5f9d88b9c1f4e2a3b4c5d6e7');
    expect(received?.existingImageSizes).toEqual(SIZES);
  });

  it('returns undefined when the mirror yields nothing', async () => {
    setCatalogImageMirrorImplementationForTests(async () => undefined);
    const result = await rehostPodcastImage('https://cdn.example/c.jpg', {
      source: 'rss',
      entityType: 'podcast',
      externalId: 'g',
    });
    expect(result).toBeUndefined();
  });
});
