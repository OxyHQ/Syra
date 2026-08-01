import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  asString,
  clearEnrichmentCache,
  htmlToPlainText,
  fetchEnrichmentJson,
  setEnrichmentFetchForTests,
  ENRICHMENT_HOSTS,
} from './enrichmentHttp';
import {
  findWikidataItemByArtistMbid,
  fetchWikidataArtistFacts,
  lookupArtistOnWikidata,
} from './wikidata';
import { fetchCommonsImage } from './wikimediaCommons';
import { fetchCoverArtForRelease, fetchCoverArtForReleaseGroup } from './coverArtArchive';
import payloads from './__fixtures__/enrichment-payloads.json';

/**
 * The payloads are REAL captured responses — Wikidata's entity document for
 * The Beatles, a Commons `imageinfo` reply, a Cover Art Archive release group.
 * Testing the parsers against a hand-written approximation would test the
 * approximation; these carry the genuine oddities (`novalue` snaks, HTML in the
 * attribution field, a `missing` page, times whose precision is a bare year).
 */
const BEATLES_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';
const ABBEY_ROAD_RELEASE_GROUP = '9162580e-5df4-32de-80cc-f45a8d8a9b1d';

/** Routes a URL to the captured payload it corresponds to. */
function routeToPayload(url: string): unknown | undefined {
  if (url.includes('list=search')) return payloads.wikidataSearch;
  if (url.includes('Special:EntityData')) return payloads.wikidataEntity;
  if (url.includes('action=wbgetentities')) return payloads.wikidataLabels;
  if (url.includes('commons.wikimedia.org')) {
    // Decoded, because the title is percent-encoded in the URL and matching the
    // raw form silently routes the missing-file case to the present-file payload
    // — which passes the parser and fails the assertion for the wrong reason.
    return decodeURIComponent(url).includes('No Such File')
      ? payloads.commonsMissing
      : payloads.commonsImage;
  }
  if (url.includes('coverartarchive.org')) return payloads.coverArtArchive;
  return undefined;
}

let requestedUrls: string[] = [];

beforeEach(() => {
  requestedUrls = [];
  setEnrichmentFetchForTests(async (url) => {
    requestedUrls.push(url);
    return routeToPayload(url);
  });
});
afterEach(() => {
  setEnrichmentFetchForTests();
});

// ── The HTTP layer ──────────────────────────────────────────────────────────

describe('enrichmentHttp — the host allowlist', () => {
  it('refuses a host that is not an enrichment source', async () => {
    // These URLs are built from identifiers found in a stranger's uploaded file.
    // A client that followed wherever those pointed would be a request-forgery
    // primitive, so the check is a throw rather than a logged warning.
    await expect(fetchEnrichmentJson('https://evil.example.com/a.json')).rejects.toThrow(
      /not an allowed enrichment host/,
    );
    await expect(fetchEnrichmentJson('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('refuses plain HTTP even to an allowed host', async () => {
    await expect(fetchEnrichmentJson('http://www.wikidata.org/x.json')).rejects.toThrow(/HTTPS/);
  });

  it('refuses a host that merely CONTAINS an allowed one', async () => {
    // `coverartarchive.org.evil.example` and `evil.example/coverartarchive.org`
    // both pass a naive substring check.
    await expect(
      fetchEnrichmentJson('https://coverartarchive.org.evil.example/release/x'),
    ).rejects.toThrow(/not an allowed enrichment host/);
    await expect(
      fetchEnrichmentJson('https://evil.example/coverartarchive.org/release/x'),
    ).rejects.toThrow(/not an allowed enrichment host/);
  });

  it('allows exactly the three documented sources', () => {
    expect([...ENRICHMENT_HOSTS].sort()).toEqual([
      'commons.wikimedia.org',
      'coverartarchive.org',
      'www.wikidata.org',
    ]);
  });
});

describe('enrichmentHttp — caching', () => {
  it('asks for the same URL once', async () => {
    const url = `https://www.wikidata.org/wiki/Special:EntityData/Q1299.json`;
    await fetchEnrichmentJson(url);
    await fetchEnrichmentJson(url);
    await fetchEnrichmentJson(url);
    expect(requestedUrls.filter((requested) => requested === url)).toHaveLength(1);
  });

  it('asks again after the cache is cleared', async () => {
    const url = `https://www.wikidata.org/wiki/Special:EntityData/Q1299.json`;
    await fetchEnrichmentJson(url);
    clearEnrichmentCache();
    await fetchEnrichmentJson(url);
    expect(requestedUrls.filter((requested) => requested === url)).toHaveLength(2);
  });
});

describe('htmlToPlainText', () => {
  it('strips the markup Commons wraps an attribution in', () => {
    expect(
      htmlToPlainText('<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">Bo&nbsp;Trenter</a>'),
    ).toBe('Bo Trenter');
    expect(htmlToPlainText('Jane &amp; John <b>Doe</b>')).toBe('Jane & John Doe');
    expect(htmlToPlainText('a<br/>b')).toBe('a b');
  });
});

// ── Wikidata ────────────────────────────────────────────────────────────────

describe('wikidata — finding the item by MusicBrainz artist id', () => {
  it('resolves a MBID to its Wikidata item', async () => {
    expect(await findWikidataItemByArtistMbid(BEATLES_MBID)).toBe('Q1299');
  });

  it('refuses anything that is not a MBID, without making a request', async () => {
    // The gate that keeps a name-based lookup impossible: there is no overload
    // that takes a name, and a non-MBID string never reaches the network.
    expect(await findWikidataItemByArtistMbid('The Beatles')).toBeUndefined();
    expect(await findWikidataItemByArtistMbid('')).toBeUndefined();
    expect(requestedUrls).toHaveLength(0);
  });

  it('abstains when more than one item claims the same MBID', async () => {
    setEnrichmentFetchForTests(async () => ({
      query: { search: [{ title: 'Q1299' }, { title: 'Q9999' }] },
    }));
    // A duplicate in Wikidata is not a coin to flip: picking one is how the
    // wrong face reaches a profile.
    expect(await findWikidataItemByArtistMbid(BEATLES_MBID)).toBeUndefined();
  });

  it('abstains when nothing claims it', async () => {
    setEnrichmentFetchForTests(async () => ({ query: { search: [] } }));
    expect(await findWikidataItemByArtistMbid(BEATLES_MBID)).toBeUndefined();
  });
});

describe('wikidata — reading the entity', () => {
  it('reads the facts a profile needs', async () => {
    const facts = await fetchWikidataArtistFacts('Q1299');
    if (!facts) throw new Error('expected facts');

    expect(facts.itemId).toBe('Q1299');
    expect(facts.name).toBe('The Beatles');
    expect(facts.description).toBe('English pop rock band (1960–1970)');
    expect(facts.imageFileName).toBe('Beatles Trenter 1963.jpg');
    expect(facts.officialWebsite).toBe('https://thebeatles.com');
    expect(facts.discogsArtistId).toBe('82730');
    expect(facts.aliases.length).toBeGreaterThan(0);
  });

  /**
   * The precision rule. Wikidata states the band's inception as
   * `+1960-00-00T00:00:00Z` with `precision: 9` (year). Rendering that as
   * `1960-01-01` would put a founding DAY on the profile that the source never
   * claimed — an invented fact, which is the one thing this whole design refuses.
   */
  it('keeps a date at the precision the source stated it', async () => {
    const facts = await fetchWikidataArtistFacts('Q1299');
    expect(facts?.activeFrom).toBe('1960');
    expect(facts?.activeUntil).toBe('1970-04-10');
  });

  it('resolves item references to readable names', async () => {
    const facts = await fetchWikidataArtistFacts('Q1299');
    if (!facts) throw new Error('expected facts');

    // A profile listing "Q1203" as a band member is worse than one listing none.
    expect(facts.country?.name).toBe('United Kingdom');
    expect(facts.members.map((member) => member.name)).toContain('John Lennon');
    expect(facts.labels.map((label) => label.name)).toContain('Parlophone');
    for (const member of facts.members) {
      expect(member.name === undefined || member.name.startsWith('Q')).toBe(false);
    }
  });

  it('ignores a claim with no value rather than reading it as data', async () => {
    // `novalue`/`somevalue` snaks carry no `datavalue` at all. Reading one as an
    // empty string would write a blank over a field.
    setEnrichmentFetchForTests(async () => ({
      entities: {
        Q1: { claims: { P18: [{ mainsnak: { snaktype: 'novalue', property: 'P18' } }] } },
      },
    }));
    const facts = await fetchWikidataArtistFacts('Q1');
    expect(facts?.imageFileName).toBeUndefined();
  });

  it('refuses an item id that is not one', async () => {
    expect(await fetchWikidataArtistFacts('P18')).toBeUndefined();
    expect(await fetchWikidataArtistFacts('../../etc/passwd')).toBeUndefined();
    expect(requestedUrls).toHaveLength(0);
  });

  it('lookupArtistOnWikidata joins the two steps', async () => {
    const facts = await lookupArtistOnWikidata(BEATLES_MBID);
    expect(facts?.itemId).toBe('Q1299');
  });
});

// ── Commons ─────────────────────────────────────────────────────────────────

describe('wikimediaCommons — the licence is the point', () => {
  it('captures licence, attribution and the FILE PAGE', async () => {
    const image = await fetchCommonsImage('Beatles Trenter 1963.jpg');
    if (!image) throw new Error('expected an image');

    expect(image.licence.licence).toBe('Public domain');
    expect(image.licence.attribution).toBe('Bo Trenter');
    // The file page, not the raw bytes: only the page states the author and the
    // licence, so only the page discharges attribution.
    expect(image.licence.sourceUrl).toBe(
      'https://commons.wikimedia.org/wiki/File:Beatles_Trenter_1963.jpg',
    );
    expect(image.licence.sourceUrl).not.toContain('upload.wikimedia.org');
    expect(image.url).toContain('upload.wikimedia.org');
  });

  it('returns nothing for a file that does not exist', async () => {
    expect(await fetchCommonsImage('Syra No Such File 9f3a2b.jpg')).toBeUndefined();
  });

  it('REFUSES an image whose licence cannot be read', async () => {
    setEnrichmentFetchForTests(async () => ({
      query: {
        pages: {
          '1': {
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/x.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
                extmetadata: { Artist: { value: 'Someone' } },
              },
            ],
          },
        },
      },
    }));
    // No licence field at all. Importing it anyway is the licence breach this
    // module exists to make impossible.
    expect(await fetchCommonsImage('X.jpg')).toBeUndefined();
  });

  it('REFUSES an image with nobody to credit', async () => {
    setEnrichmentFetchForTests(async () => ({
      query: {
        pages: {
          '1': {
            imageinfo: [
              {
                url: 'https://upload.wikimedia.org/x.jpg',
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
                extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } },
              },
            ],
          },
        },
      },
    }));
    // CC BY-SA is satisfied by naming the author. With no author there is no way
    // to satisfy it, so there is no way to use the image.
    expect(await fetchCommonsImage('X.jpg')).toBeUndefined();
  });

  const nonFree = ['Non-free fair use', 'CC BY-NC 4.0', 'CC BY-ND 4.0', 'Fair use'];
  for (const licence of nonFree) {
    it(`REFUSES a "${licence}" file even though Commons hosts it`, async () => {
      setEnrichmentFetchForTests(async () => ({
        query: {
          pages: {
            '1': {
              imageinfo: [
                {
                  url: 'https://upload.wikimedia.org/x.jpg',
                  descriptionurl: 'https://commons.wikimedia.org/wiki/File:X.jpg',
                  extmetadata: {
                    LicenseShortName: { value: licence },
                    Artist: { value: 'Someone' },
                  },
                },
              ],
            },
          },
        },
      }));
      expect(await fetchCommonsImage('X.jpg')).toBeUndefined();
    });
  }
});

// ── Cover Art Archive ───────────────────────────────────────────────────────

describe('coverArtArchive', () => {
  it('returns the front cover, keyed to the release that actually has it', async () => {
    const cover = await fetchCoverArtForReleaseGroup(ABBEY_ROAD_RELEASE_GROUP);
    if (!cover) throw new Error('expected a cover');

    expect(cover.url).toContain('coverartarchive.org');
    // The release-group endpoint answers with whichever RELEASE carries the art
    // and names it. Recording the id we ASKED for would point the provenance
    // link at a release that has no artwork.
    expect(cover.releaseMbid).toBe('31765b9f-e969-4257-855f-c7ea1f657b2a');
    expect(cover.licence.sourceUrl).toBe(
      'https://musicbrainz.org/release/31765b9f-e969-4257-855f-c7ea1f657b2a',
    );
    expect(cover.licence.attribution).toBe('Cover Art Archive');
  });

  it('ignores a back cover — wrong art is worse than none', async () => {
    setEnrichmentFetchForTests(async () => ({
      images: [{ image: 'https://coverartarchive.org/a.jpg', front: false, types: ['Back'], approved: true }],
    }));
    expect(await fetchCoverArtForRelease('31765b9f-e969-4257-855f-c7ea1f657b2a')).toBeUndefined();
  });

  it('ignores an unapproved image', async () => {
    setEnrichmentFetchForTests(async () => ({
      images: [{ image: 'https://coverartarchive.org/a.jpg', front: true, types: ['Front'], approved: false }],
    }));
    // An unapproved image is a pending edit — anything a contributor uploaded
    // minutes ago, not artwork the archive stands behind.
    expect(await fetchCoverArtForRelease('31765b9f-e969-4257-855f-c7ea1f657b2a')).toBeUndefined();
  });

  it('prefers a stored thumbnail over the full-size original', async () => {
    setEnrichmentFetchForTests(async () => ({
      images: [
        {
          image: 'https://coverartarchive.org/full.jpg',
          front: true,
          types: ['Front'],
          approved: true,
          thumbnails: { '250': 'https://coverartarchive.org/250.jpg', '1200': 'https://coverartarchive.org/1200.jpg' },
        },
      ],
    }));
    const cover = await fetchCoverArtForRelease('31765b9f-e969-4257-855f-c7ea1f657b2a');
    expect(cover?.url).toBe('https://coverartarchive.org/1200.jpg');
  });

  it('falls back to the original when no thumbnail was generated', async () => {
    setEnrichmentFetchForTests(async () => ({
      images: [{ image: 'https://coverartarchive.org/full.jpg', front: true, types: ['Front'], approved: true }],
    }));
    const cover = await fetchCoverArtForRelease('31765b9f-e969-4257-855f-c7ea1f657b2a');
    expect(cover?.url).toBe('https://coverartarchive.org/full.jpg');
  });

  it('refuses anything that is not a release MBID', async () => {
    expect(await fetchCoverArtForRelease('Abbey Road')).toBeUndefined();
    expect(requestedUrls).toHaveLength(0);
  });
});

describe('asString', () => {
  it('treats blank and non-string values as absent', () => {
    expect(asString('  x  ')).toBe('x');
    expect(asString('   ')).toBeUndefined();
    expect(asString(42)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
  });
});
