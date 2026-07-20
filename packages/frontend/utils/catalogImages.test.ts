import {
  normalizeCatalogImageSizes,
  normalizeCatalogTrackImages,
  resolveCatalogImageUrl,
} from './catalogImages';

const API_IMAGES = 'http://localhost:3000/api/images';

describe('catalog image URL normalization', () => {
  it('turns a Mongo image id into an absolute backend image URL', () => {
    expect(resolveCatalogImageUrl('111111111111111111111111')).toBe(
      `${API_IMAGES}/111111111111111111111111`,
    );
  });

  it('turns an API image path into an absolute backend image URL', () => {
    expect(resolveCatalogImageUrl('/api/images/222222222222222222222222')).toBe(
      `${API_IMAGES}/222222222222222222222222`,
    );
  });

  it('keeps absolute backend image URLs', () => {
    const url = `${API_IMAGES}/333333333333333333333333`;
    expect(resolveCatalogImageUrl(url)).toBe(url);
  });

  it('rejects external provider image URLs', () => {
    expect(resolveCatalogImageUrl('https://cdn.example.com/art.jpg')).toBeUndefined();
  });

  it('normalizes image sizes and drops external variants', () => {
    expect(
      normalizeCatalogImageSizes({
        small: {
          id: '444444444444444444444444',
          url: '/api/images/444444444444444444444444',
          width: 160,
          height: 160,
        },
        large: {
          id: 'external',
          url: 'https://cdn.example.com/cover.jpg',
          width: 640,
          height: 640,
        },
      }),
    ).toEqual({
      small: {
        id: '444444444444444444444444',
        url: `${API_IMAGES}/444444444444444444444444`,
        width: 160,
        height: 160,
      },
    });
  });

  it('normalizes track image arrays and drops external images', () => {
    expect(
      normalizeCatalogTrackImages([
        { url: '/api/images/555555555555555555555555', width: 160, height: 160 },
        { url: 'https://cdn.example.com/cover.jpg', width: 640, height: 640 },
      ]),
    ).toEqual([
      {
        url: `${API_IMAGES}/555555555555555555555555`,
        width: 160,
        height: 160,
      },
    ]);
  });
});
