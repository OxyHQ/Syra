import { describe, it, expect, beforeAll } from 'bun:test';
import path from 'path';
import {
  buildRawTagDump,
  extractMetadata,
  hashFile,
  RAW_TAGS_MAX_BYTES,
  type ExtractedMetadata,
  type NativeTag,
} from './extractMetadata';

const FIXTURES = path.join(__dirname, '__fixtures__');
const INDIE_MP3 = path.join(FIXTURES, 'indie-id3v2.mp3');
const PURCHASED_M4A = path.join(FIXTURES, 'purchased-itunes.m4a');
const CDRIP_FLAC = path.join(FIXTURES, 'cdrip-picard.flac');
const UNTAGGED_WAV = path.join(FIXTURES, 'untagged.wav');

/**
 * THE VACUITY FLOOR.
 *
 * Every assertion in this file about "what the tags say" is worthless if the
 * parser silently returned nothing — a broken parse and a genuinely untagged
 * file look identical from the outside, and a screening step that reads zero
 * markers from a file full of markers reports "clean" with total confidence.
 * So three of the four fixtures assert a minimum native-tag count BEFORE
 * anything else, and the counts are the real ones (32 / 19 / 36 at the time of
 * writing) minus a little slack for a tagger change, not a token `> 0`.
 */
const MINIMUM_NATIVE_TAGS: ReadonlyArray<readonly [string, number]> = [
  [INDIE_MP3, 30],
  [PURCHASED_M4A, 18],
  [CDRIP_FLAC, 34],
];

describe('extractMetadata — vacuity floor', () => {
  for (const [file, minimum] of MINIMUM_NATIVE_TAGS) {
    it(`${path.basename(file)} parses at least ${minimum} native tags`, async () => {
      const extracted = await extractMetadata(file);
      expect(extracted.nativeTags.length).toBeGreaterThanOrEqual(minimum);
    });
  }

  it('untagged.wav is the ONLY fixture allowed to parse zero tags', async () => {
    const extracted = await extractMetadata(UNTAGGED_WAV);
    expect(extracted.nativeTags).toEqual([]);
    // …and it still extracted, rather than throwing on a file with no metadata.
    expect(extracted.technical.durationSec).toBeGreaterThan(0);
  });
});

describe('extractMetadata — technical facts come from the stream, not the tags', () => {
  it('measures duration, codec, sample rate and channels for every fixture', async () => {
    const cases: ReadonlyArray<readonly [string, string, number, number]> = [
      [INDIE_MP3, 'mp3', 44100, 2],
      [PURCHASED_M4A, 'aac', 44100, 2],
      [CDRIP_FLAC, 'flac', 44100, 2],
      [UNTAGGED_WAV, 'pcm_s16le', 44100, 2],
    ];

    for (const [file, codec, sampleRate, channels] of cases) {
      const { technical } = await extractMetadata(file);
      expect(technical.codec).toBe(codec);
      expect(technical.sampleRate).toBe(sampleRate);
      expect(technical.channels).toBe(channels);
      // The fixtures are 2.5 s of audio; encoder padding moves this by frames,
      // never by seconds. A human-typed duration is what this replaces.
      expect(technical.durationSec).toBeGreaterThan(2.4);
      expect(technical.durationSec).toBeLessThan(2.7);
    }
  });

  /**
   * `container` is ffmpeg's DEMUXER FAMILY, not a file extension — an m4a reports
   * the whole `mov,mp4,m4a,3gp,3g2,mj2` list. Pinned because it is genuinely
   * surprising, and because anything that string-compared it against `'m4a'`
   * would silently never match.
   */
  it('reports ffmpeg\'s demuxer family as the container, verbatim', async () => {
    const mp3 = await extractMetadata(INDIE_MP3);
    expect(mp3.technical.container).toBe('mp3');

    const m4a = await extractMetadata(PURCHASED_M4A);
    expect(m4a.technical.container).toContain('m4a');
    expect(m4a.technical.container).toContain(',');
  });

  it('leaves an unmeasurable field absent rather than reporting zero', async () => {
    // A fabricated `sampleRate: 0` is indistinguishable from a measurement.
    for (const file of [INDIE_MP3, PURCHASED_M4A, CDRIP_FLAC, UNTAGGED_WAV]) {
      const { technical } = await extractMetadata(file);
      for (const value of [technical.sampleRate, technical.channels, technical.bitrateKbps]) {
        expect(value === undefined || value > 0).toBe(true);
      }
    }
  });

  it('hashes the file and reports its size', async () => {
    const extracted = await extractMetadata(INDIE_MP3);
    const hashed = await hashFile(INDIE_MP3);
    expect(extracted.sha256).toBe(hashed.sha256);
    expect(extracted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extracted.sizeBytes).toBe(hashed.sizeBytes);
    expect(extracted.sizeBytes).toBeGreaterThan(0);
  });
});

describe('extractMetadata — descriptive tags (indie MP3, ID3v2.4)', () => {
  let extracted: ExtractedMetadata;

  beforeAll(async () => {
    extracted = await extractMetadata(INDIE_MP3);
  });

  it('reads the full descriptive set', () => {
    expect(extracted.title).toBe('Midnight Ferry');
    expect(extracted.artistName).toBe('Nadia Ortiz feat. Kofi Mensah');
    expect(extracted.albumArtistName).toBe('Nadia Ortiz');
    expect(extracted.albumName).toBe('Harbour Lights');
    expect(extracted.trackNumber).toBe(3);
    expect(extracted.totalTracks).toBe(12);
    expect(extracted.discNumber).toBe(1);
    expect(extracted.totalDiscs).toBe(2);
    expect(extracted.year).toBe(2023);
    expect(extracted.releaseDate).toBe('2023-04-18');
    expect(extracted.originalReleaseDate).toBe('2019-11-02');
    expect(extracted.genres).toEqual(['Indie Pop']);
    expect(extracted.isrc).toBe('ESA452300137');
    expect(extracted.upc).toBe('8437011234567');
    expect(extracted.catalogNumber).toBe('FARO-014');
    expect(extracted.label).toBe('Faro Records');
    expect(extracted.media).toBe('Digital Media');
    expect(extracted.releaseCountry).toBe('ES');
    expect(extracted.bpm).toBe(112);
    expect(extracted.key).toBe('F#m');
    expect(extracted.language).toBe('spa');
    expect(extracted.copyright).toBe('2023 Nadia Ortiz');
    expect(extracted.comment).toBe('Recorded at Faro Studios, Cádiz');
  });

  it('reads lyrics and ReplayGain', async () => {
    expect(extracted.lyrics?.text).toContain('La niebla cae sobre el puerto');
    expect(extracted.lyrics?.language).toBe('spa');
    expect(extracted.replayGain?.trackDb).toBeCloseTo(-8.42, 2);
    expect(extracted.replayGain?.trackPeak).toBeCloseTo(0.988525, 5);
    // Album gain is absent on purpose — see the fixture generator.
    expect(extracted.replayGain?.albumDb).toBeUndefined();
  });

  it('reads every embedded picture with its declared type', () => {
    const types = extracted.pictures.map((picture) => picture.type);
    expect(types).toEqual(['Cover (front)', 'Cover (back)', 'Artist/performer']);
    for (const picture of extracted.pictures) {
      expect(picture.mimeType).toBe('image/jpeg');
      expect(picture.data.length).toBeGreaterThan(0);
    }
  });

  /**
   * The credit this file's `common` view does NOT contain. `music-metadata`
   * parses the TIPL frame but its ID3 mapper reaches the roles only through
   * synthetic `TIPL:<role>` ids the native dictionary never emits, so reading
   * the normalized view alone loses every producer, engineer and mixer on every
   * ID3-tagged file. If this test ever starts passing for the wrong reason, the
   * TIPL frame in `__fixtures__/generate.ts` is what it is asserting against.
   */
  it('recovers TIPL involved-people credits, which the normalized view drops', () => {
    expect(extracted.credits).toContainEqual({ name: 'Kofi Mensah', role: 'producer' });
    expect(extracted.credits).toContainEqual({ name: 'Tomás Ruiz', role: 'engineer' });
    expect(extracted.credits).toContainEqual({ name: 'Ana Beltrán', role: 'mixer' });
    expect(extracted.credits).toContainEqual({ name: 'Nadia Ortiz', role: 'arranger' });
  });

  it('reads the tag-mapped credits too, and splits the featured performer out', () => {
    expect(extracted.credits).toContainEqual({ name: 'Kofi Mensah', role: 'artist' });
    expect(extracted.credits).toContainEqual({ name: 'Nadia Ortiz', role: 'albumartist' });
    expect(extracted.credits).toContainEqual({ name: 'Nadia Ortiz', role: 'composer' });
    expect(extracted.credits).toContainEqual({ name: 'Rocío Vela', role: 'lyricist' });
    expect(extracted.credits).toContainEqual({ name: 'Elena Marchetti', role: 'conductor' });
    expect(extracted.credits).toContainEqual({ name: 'DJ Sirocco', role: 'remixer' });
  });
});

describe('extractMetadata — Vorbis comments (CD rip FLAC)', () => {
  it('reads MusicBrainz identifiers, the barcode and the release metadata', async () => {
    const extracted = await extractMetadata(CDRIP_FLAC);

    expect(extracted.title).toBe('Sodium Light');
    expect(extracted.artistName).toBe('Kestrel Lane');
    expect(extracted.albumName).toBe('The Longest Winter');
    expect(extracted.trackNumber).toBe(7);
    expect(extracted.totalTracks).toBe(14);
    expect(extracted.isrc).toBe('GBAYE9800712');
    expect(extracted.upc).toBe('5016958034528');
    expect(extracted.catalogNumber).toBe('BRIDGE045CD');
    expect(extracted.label).toBe('Bridgewater Recordings');
    expect(extracted.media).toBe('CD');
    expect(extracted.releaseCountry).toBe('GB');
    expect(extracted.encodedBy).toBe('Exact Audio Copy V1.6');

    expect(extracted.musicbrainz.recordingId).toBe('c1e3f4a0-9f19-4b1e-9b52-6c8f8a0d4f11');
    expect(extracted.musicbrainz.releaseId).toBe('4f2a1d3b-8ec6-4a35-9d21-7f0c5b6e2a90');
    expect(extracted.musicbrainz.artistId).toBe('0b6c9f77-2e5a-4d6c-83a1-91b2f4c7d5e8');
    expect(extracted.musicbrainz.releaseGroupId).toBe('a7c9e211-5b3d-4f88-b0a6-1d2e3f4a5b6c');
    expect(extracted.acoustidId).toBe('e6a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7');

    expect(extracted.replayGain?.albumDb).toBeCloseTo(-6.94, 2);
  });

  it('keeps the CUESHEET in the native tags, where the provenance scorer reads it', async () => {
    const extracted = await extractMetadata(CDRIP_FLAC);
    const cuesheet = extracted.nativeTags.find((tag) => tag.id === 'CUESHEET');
    expect(cuesheet).toBeDefined();
    expect(cuesheet?.value).toContain('TRACK 07 AUDIO');
  });
});

describe('extractMetadata — iTunes atoms (purchased M4A)', () => {
  it('keeps the purchase atoms in the native tags with their values intact', async () => {
    const extracted = await extractMetadata(PURCHASED_M4A);
    const byId = new Map(extracted.nativeTags.map((tag) => [tag.id.trim(), tag.value]));

    expect(byId.get('apID')).toBe('buyer.account@icloud.com');
    expect(byId.get('cnID')).toBe('1136291289');
    expect(byId.get('atID')).toBe('1136290477');
    expect(byId.get('sfID')).toBe('143444');
    expect(byId.get('purd')).toBe('2016-07-02 19:41:07');
    expect(byId.get('ownr')).toBe('A. Buyer');
    expect(byId.get('xid')).toBe('Longwave Recordings:isrc:GBAHT1600042');
  });

  it('reads the advisory atom as explicit', async () => {
    const extracted = await extractMetadata(PURCHASED_M4A);
    expect(extracted.isExplicit).toBe(true);
  });
});

describe('extractMetadata — a file with no artist at all', () => {
  it('succeeds, and reports no artist rather than inventing one', async () => {
    const extracted = await extractMetadata(UNTAGGED_WAV);

    expect(extracted.artistName).toBeUndefined();
    expect(extracted.albumArtistName).toBeUndefined();
    expect(extracted.artists).toEqual([]);
    expect(extracted.title).toBeUndefined();
    expect(extracted.credits).toEqual([]);
    expect(extracted.pictures).toEqual([]);
    expect(extracted.isrc).toBeUndefined();
    // The parts that do not depend on tags still work.
    expect(extracted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extracted.technical.durationSec).toBeGreaterThan(0);
  });
});

describe('buildRawTagDump', () => {
  function tag(index: number, size: number): NativeTag {
    return { tagType: 'ID3v2.4', id: `T${index}`, value: 'x'.repeat(size) };
  }

  it('keeps everything when it fits', () => {
    const dump = buildRawTagDump([tag(1, 10), tag(2, 10)]);
    expect(dump.truncated).toBe(false);
    expect(JSON.parse(dump.json)).toHaveLength(2);
    expect(dump.originalByteLength).toBe(Buffer.byteLength(dump.json, 'utf8'));
  });

  it('drops whole entries to fit the cap, and stays parseable JSON', () => {
    const tags = Array.from({ length: 60 }, (_, index) => tag(index, 1024));
    const dump = buildRawTagDump(tags);

    expect(Buffer.byteLength(dump.json, 'utf8')).toBeLessThanOrEqual(RAW_TAGS_MAX_BYTES);
    expect(dump.truncated).toBe(true);
    expect(dump.originalByteLength).toBeGreaterThan(RAW_TAGS_MAX_BYTES);
    // The point of dropping entries rather than cutting the string: the stored
    // dump can still be re-parsed years later to answer a DMCA question.
    const parsed = JSON.parse(dump.json) as NativeTag[];
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(tags.length);
    expect(parsed[0].id).toBe('T0');
  });

  it('caps the dump written for a real fixture', async () => {
    const extracted = await extractMetadata(INDIE_MP3);
    expect(Buffer.byteLength(extracted.rawTags.json, 'utf8')).toBeLessThanOrEqual(RAW_TAGS_MAX_BYTES);
    // Embedded artwork must be a descriptor, not 6 KB of base64 per picture.
    expect(extracted.rawTags.json).toContain('[binary');
    expect(extracted.rawTags.truncated).toBe(false);
  });
});
