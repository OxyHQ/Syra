import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import path from 'path';
import { clear, connect, disconnect } from '../../test/mongo';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import { extractMetadata, type ExtractedMetadata } from './extractMetadata';
import {
  COMMERCIAL_SCORE_THRESHOLD,
  collectProvenanceSignals,
  scoreProvenance,
  type ProvenanceMarkerCode,
  type ScreeningReport,
} from './provenanceSignals';

const FIXTURES = path.join(__dirname, '__fixtures__');
const INDIE_MP3 = path.join(FIXTURES, 'indie-id3v2.mp3');
const PURCHASED_M4A = path.join(FIXTURES, 'purchased-itunes.m4a');
const CDRIP_FLAC = path.join(FIXTURES, 'cdrip-picard.flac');
const UNTAGGED_WAV = path.join(FIXTURES, 'untagged.wav');

let indie: ExtractedMetadata;
let purchased: ExtractedMetadata;
let cdRip: ExtractedMetadata;
let untagged: ExtractedMetadata;

beforeAll(async () => {
  await connect();
  [indie, purchased, cdRip, untagged] = await Promise.all([
    extractMetadata(INDIE_MP3),
    extractMetadata(PURCHASED_M4A),
    extractMetadata(CDRIP_FLAC),
    extractMetadata(UNTAGGED_WAV),
  ]);
});
afterEach(clear);
afterAll(disconnect);

function codes(report: ScreeningReport): ProvenanceMarkerCode[] {
  return report.markers.map((marker) => marker.code);
}

function detailOf(report: ScreeningReport, code: ProvenanceMarkerCode): string {
  const marker = report.markers.find((entry) => entry.code === code);
  if (!marker) {
    throw new Error(`expected marker ${code}; report carried ${codes(report).join(', ') || 'none'}`);
  }
  return marker.detail;
}

// ── Mutators: what the file would look like if a tagger had stripped a marker ──

function withoutNativeTags(
  metadata: ExtractedMetadata,
  matches: (id: string) => boolean,
): ExtractedMetadata {
  return {
    ...metadata,
    nativeTags: metadata.nativeTags.filter((tag) => !matches(tag.id.trim())),
  };
}

const ITUNES_ATOMS = ['apID', 'cnID', 'atID', 'sfID', 'purd', 'ownr', 'xid'];

function stripItunesAtoms(metadata: ExtractedMetadata): ExtractedMetadata {
  return withoutNativeTags(metadata, (id) => ITUNES_ATOMS.includes(id));
}

function stripCuesheet(metadata: ExtractedMetadata): ExtractedMetadata {
  return withoutNativeTags(metadata, (id) => id.toUpperCase().endsWith('CUESHEET'));
}

function stripMusicBrainz(metadata: ExtractedMetadata): ExtractedMetadata {
  const withoutTags = withoutNativeTags(metadata, (id) => /MUSICBRAINZ|ACOUSTID/i.test(id));
  return { ...withoutTags, musicbrainz: {}, acoustidId: undefined };
}

function stripAlbumReplayGain(metadata: ExtractedMetadata): ExtractedMetadata {
  const withoutTags = withoutNativeTags(metadata, (id) => /REPLAYGAIN_ALBUM/i.test(id));
  return {
    ...withoutTags,
    replayGain: metadata.replayGain ? { ...metadata.replayGain, albumDb: undefined } : undefined,
  };
}

function stripRipperEncoder(metadata: ExtractedMetadata): ExtractedMetadata {
  const withoutTags = withoutNativeTags(metadata, (id) => /^ENCODED/i.test(id));
  return { ...withoutTags, encodedBy: undefined, encoderSettings: undefined };
}

// ── The central semantic ────────────────────────────────────────────────────

describe('a bare ISRC is not evidence of anything', () => {
  it('the indie MP3 carries an ISRC and still screens clean', () => {
    // If this ever fails, every independent artist uploading their own record —
    // the users this feature exists for — is being blocked by their distributor
    // having done its job.
    expect(indie.isrc).toBe('ESA452300137');

    const report = scoreProvenance(indie);
    expect(report.verdict).toBe('clean');
    expect(report.markers).toEqual([]);
    expect(report.score).toBe(0);
  });

  it('the same ISRC resolving to a released recording IS blocking', () => {
    const report = scoreProvenance(indie, {
      isrcRegistryMatch: {
        isrc: 'ESA452300137',
        recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
        title: 'Midnight Ferry',
        artistCredit: 'Nadia Ortiz',
        releaseCount: 3,
      },
    });

    expect(report.verdict).toBe('commercial');
    expect(codes(report)).toContain('isrc.resolves-to-release');
    expect(detailOf(report, 'isrc.resolves-to-release')).toContain('3 release(s)');
  });

  it('resolving to a recording with NO releases is suspect, not commercial', () => {
    const report = scoreProvenance(indie, {
      isrcRegistryMatch: {
        isrc: 'ESA452300137',
        recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
        title: 'Midnight Ferry',
        artistCredit: 'Nadia Ortiz',
        releaseCount: 0,
      },
    });

    expect(codes(report)).toContain('isrc.resolves-to-recording');
    expect(codes(report)).not.toContain('isrc.resolves-to-release');
    expect(report.verdict).toBe('suspect');
  });

  it('records a disagreement with the known release as its own marker', () => {
    const report = scoreProvenance(indie, {
      isrcRegistryMatch: {
        isrc: 'ESA452300137',
        recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
        title: 'Something Else Entirely',
        artistCredit: 'A Different Band',
        lengthMs: 240_000,
        releaseCount: 1,
      },
    });

    const detail = detailOf(report, 'isrc.metadata-mismatch');
    expect(detail).toContain('Midnight Ferry');
    expect(detail).toContain('Something Else Entirely');
    expect(detail).toContain('A Different Band');
    expect(detail).toContain('duration');
  });
});

// ── Mutation testing ────────────────────────────────────────────────────────

describe('MUTATION — iTunes purchase atoms', () => {
  it('the untouched file is commercial, and the marker names the atoms it found', () => {
    const report = scoreProvenance(purchased);

    expect(report.verdict).toBe('commercial');
    const detail = detailOf(report, 'itunes.purchase-atoms');
    expect(detail).toContain('apID=buyer.account@icloud.com');
    expect(detail).toContain('ownr=A. Buyer');
    expect(detail).toContain('purd=2016-07-02 19:41:07');
  });

  it('stripping the atoms changes the verdict and removes exactly those markers', () => {
    const before = scoreProvenance(purchased);
    const after = scoreProvenance(stripItunesAtoms(purchased));

    expect(before.verdict).toBe('commercial');
    expect(after.verdict).not.toBe('commercial');
    expect(after.verdict).toBe('clean');

    expect(codes(before)).toContain('itunes.purchase-atoms');
    expect(codes(before)).toContain('store.xid-vendor');
    expect(codes(after)).not.toContain('itunes.purchase-atoms');
    expect(codes(after)).not.toContain('store.xid-vendor');
    expect(after.score).toBeLessThan(before.score);
  });

  /**
   * The check that proves the check works.
   *
   * Removing ONE atom must leave the verdict alone (the others still fire) while
   * the marker's detail stops naming the removed atom. A hardcoded detail string
   * would pass every assertion above and fail here, which is the whole point: a
   * screening report that cannot distinguish "found apID" from "found something"
   * is evidence of nothing in an appeal.
   */
  for (const atom of ITUNES_ATOMS) {
    it(`removing only ${atom} keeps the verdict and drops it from the detail`, () => {
      const mutated = withoutNativeTags(purchased, (id) => id === atom);
      const report = scoreProvenance(mutated);

      expect(report.verdict).toBe('commercial');
      const detail = detailOf(report, 'itunes.purchase-atoms');
      expect(detail).not.toContain(`${atom}=`);
      // …and every other atom is still named.
      for (const other of ITUNES_ATOMS) {
        if (other === atom) continue;
        expect(detail).toContain(`${other}=`);
      }
    });
  }
});

describe('MUTATION — the CD-rip markers', () => {
  it('the untouched rip is commercial on four medium markers', () => {
    const report = scoreProvenance(cdRip);

    expect(codes(report).sort()).toEqual([
      'cdrip.album-replaygain',
      'cdrip.cuesheet',
      'cdrip.encoder',
      'musicbrainz.tagged',
    ]);
    expect(report.score).toBe(COMMERCIAL_SCORE_THRESHOLD);
    expect(report.verdict).toBe('commercial');
  });

  const mutations: ReadonlyArray<
    readonly [ProvenanceMarkerCode, (metadata: ExtractedMetadata) => ExtractedMetadata]
  > = [
    ['cdrip.cuesheet', stripCuesheet],
    ['musicbrainz.tagged', stripMusicBrainz],
    ['cdrip.album-replaygain', stripAlbumReplayGain],
    ['cdrip.encoder', stripRipperEncoder],
  ];

  for (const [code, mutate] of mutations) {
    it(`stripping ${code} drops the verdict to suspect and removes only that marker`, () => {
      const before = scoreProvenance(cdRip);
      const after = scoreProvenance(mutate(cdRip));

      expect(before.verdict).toBe('commercial');
      expect(after.verdict).toBe('suspect');

      expect(codes(before)).toContain(code);
      expect(codes(after)).not.toContain(code);
      for (const [other] of mutations) {
        if (other === code) continue;
        expect(codes(after)).toContain(other);
      }
    });
  }

  it('names the evidence rather than the category', () => {
    const report = scoreProvenance(cdRip);
    expect(detailOf(report, 'cdrip.cuesheet')).toContain('REM GENRE Post-Rock');
    expect(detailOf(report, 'cdrip.encoder')).toContain('Exact Audio Copy V1.6');
    expect(detailOf(report, 'musicbrainz.tagged')).toContain(
      'c1e3f4a0-9f19-4b1e-9b52-6c8f8a0d4f11',
    );
    expect(detailOf(report, 'cdrip.album-replaygain')).toContain('-6.94');
  });
});

// ── Stripped tags ───────────────────────────────────────────────────────────

describe('stripped tags at release-grade encoding', () => {
  it('an untagged CD-quality file is suspect', () => {
    expect(untagged.nativeTags).toEqual([]);
    const report = scoreProvenance(untagged);

    expect(codes(report)).toEqual(['tags.stripped-commercial-encoding']);
    expect(report.verdict).toBe('suspect');
    expect(detailOf(report, 'tags.stripped-commercial-encoding')).toContain('44100 Hz');
  });

  it('an untagged voice-memo-grade file is clean — stripping nothing is not a signal', () => {
    const voiceMemo: ExtractedMetadata = {
      ...untagged,
      technical: { ...untagged.technical, sampleRate: 22050, channels: 1 },
    };
    const report = scoreProvenance(voiceMemo);

    expect(report.markers).toEqual([]);
    expect(report.verdict).toBe('clean');
  });

  /**
   * The shape a real laundered file arrives in, and the reason this marker tests
   * release IDENTITY rather than tag COUNT.
   *
   * Measured from a file a user actually tried to upload: title and artist
   * present, `album = "Unknown Album"`, an embedded 300 px cover, and not one
   * identifier of any kind. A tag-count test reads that as a tagged file and
   * lets it through — which is exactly backwards, because somebody kept the
   * artwork and removed the provenance.
   */
  it('fires on a file whose tags were reduced to a placeholder album', () => {
    const laundered: ExtractedMetadata = {
      ...untagged,
      title: 'Por interés',
      artistName: 'Carlota Giró',
      albumName: 'Unknown Album',
      nativeTags: [
        { tagType: 'ID3v2.4', id: 'TIT2', value: 'Por interés' },
        { tagType: 'ID3v2.4', id: 'TPE1', value: 'Carlota Giró' },
        { tagType: 'ID3v2.4', id: 'TALB', value: 'Unknown Album' },
      ],
    };

    const report = scoreProvenance(laundered);

    expect(codes(report)).toContain('tags.stripped-commercial-encoding');
    const detail = detailOf(report, 'tags.stripped-commercial-encoding');
    expect(detail).toContain('none identifying a release');
    expect(detail).toContain('Unknown Album');
  });

  it('weighs `medium`, and medium alone cannot refuse a file', () => {
    // The correction this weight exists to make: the scorer only counts markers
    // that are PRESENT, so an erased file scores cleaner than an honest one. And
    // the limit on that correction: absence is weak evidence — a genuine home
    // recording has no label and no ISRC either — so it must contribute without
    // deciding.
    const report = scoreProvenance(untagged);
    const marker = report.markers.find(
      (entry) => entry.code === 'tags.stripped-commercial-encoding',
    );

    expect(marker?.weight).toBe('medium');
    expect(report.score).toBeLessThan(COMMERCIAL_SCORE_THRESHOLD);
    expect(report.verdict).not.toBe('commercial');
  });

  it('does NOT fire on a file that names a real release', () => {
    const named: ExtractedMetadata = { ...untagged, albumName: 'Harbour Lights' };
    expect(codes(scoreProvenance(named))).not.toContain('tags.stripped-commercial-encoding');
  });

  it('does NOT fire on a file carrying any release identity at all', () => {
    // One field each, so a regression that drops one from the set is caught
    // individually rather than being masked by the others.
    const identities: Array<Partial<ExtractedMetadata>> = [
      { isrc: 'ESA452300137' },
      { upc: '0602557891234' },
      { catalogNumber: 'LW-0042' },
      { label: 'Longwave Recordings' },
      { copyright: '℗ 2023 Longwave Recordings' },
      { publisher: 'Longwave Recordings' },
      { asin: 'B01N5IB20Q' },
      { acoustidId: 'e7d1b7dc-9d1e-4a1f-9f0a-2f3a1b6c8d90' },
      { musicbrainz: { recordingId: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7' } },
      { musicbrainz: { artistId: 'aaaa1111-2222-3333-4444-555566667777' } },
    ];

    for (const identity of identities) {
      const withIdentity: ExtractedMetadata = { ...untagged, ...identity };
      expect(
        codes(scoreProvenance(withIdentity)),
        `a file carrying ${Object.keys(identity)[0]} is not a file with its provenance removed`,
      ).not.toContain('tags.stripped-commercial-encoding');
    }
  });
});

// ── Other markers ───────────────────────────────────────────────────────────

describe('store and acoustic markers', () => {
  it('an ASIN blocks on its own', () => {
    const report = scoreProvenance({ ...indie, asin: 'B01N5IB20Q' });
    expect(report.verdict).toBe('commercial');
    expect(detailOf(report, 'store.asin')).toContain('B01N5IB20Q');
  });

  it('a fingerprint hit under another artist is a high marker naming the track', () => {
    const report = scoreProvenance(indie, {
      foreignFingerprintMatch: {
        trackId: '651f1c2d3e4f5a6b7c8d9e0f',
        artistName: 'Someone Else',
        bitErrorRate: 0.0031,
      },
    });

    const detail = detailOf(report, 'fingerprint.other-artist');
    expect(detail).toContain('651f1c2d3e4f5a6b7c8d9e0f');
    expect(detail).toContain('Someone Else');
    expect(detail).toContain('0.0031');
    expect(report.verdict).toBe('suspect');
  });

  /**
   * The strongest signal in the file, and the one that was unreachable until
   * `matchCatalog` started carrying acoustic evidence on its `none` arm.
   *
   * Every other marker infers commercial origin from tags a determined uploader
   * can strip. This one is Syra having already judged this exact audio
   * infringing and removed it — so it blocks outright rather than scoring.
   */
  it('re-uploading a recording Syra took down for copyright is BLOCKING', () => {
    const report = scoreProvenance(indie, {
      foreignFingerprintMatch: {
        trackId: '651f1c2d3e4f5a6b7c8d9e0f',
        artistName: 'Someone Else',
        bitErrorRate: 0.0009,
        copyrightRemoved: true,
      },
    });

    expect(report.verdict).toBe('commercial');
    expect(codes(report)).toContain('fingerprint.copyright-removed');
    expect(codes(report)).not.toContain('fingerprint.other-artist');
    const detail = detailOf(report, 'fingerprint.copyright-removed');
    expect(detail).toContain('651f1c2d3e4f5a6b7c8d9e0f');
    expect(detail).toContain('REMOVED');
  });

  it('an unavailable — not removed — recording stays the weaker marker', () => {
    // A creator unpublishing their own track is not a copyright judgement, and
    // treating it as one would block uploads on the strength of a creator's
    // visibility setting.
    const report = scoreProvenance(indie, {
      foreignFingerprintMatch: {
        trackId: '651f1c2d3e4f5a6b7c8d9e0f',
        artistName: 'Someone Else',
        bitErrorRate: 0.0009,
        copyrightRemoved: false,
      },
    });

    expect(codes(report)).toContain('fingerprint.other-artist');
    expect(codes(report)).not.toContain('fingerprint.copyright-removed');
    expect(report.verdict).toBe('suspect');
  });

  it('a blocking marker decides regardless of the score arithmetic', () => {
    // An `xid` names the vendor that issued the identifier — blocking — while
    // the file still carries no release identity of its own, so the weak
    // stripped-tags marker fires beside it. The verdict comes from the blocking
    // marker's presence, never from adding the two together.
    const report = scoreProvenance({
      ...untagged,
      nativeTags: [
        { tagType: 'iTunes', id: 'xid', value: 'Longwave Recordings:isrc:GBAHT1600042' },
      ],
    });

    expect(codes(report)).toContain('store.xid-vendor');
    expect(codes(report)).toContain('tags.stripped-commercial-encoding');
    expect(report.verdict).toBe('commercial');
  });
});

// ── Acoustic identification ─────────────────────────────────────────────────

/**
 * The marker no tagger can defeat.
 *
 * Every other commercial signal here reads something written INTO the file, and
 * all of it comes off with a tag editor. The fingerprint does not, so a file
 * scrubbed of every identifier still resolves to the recording it was made from.
 */
describe('what the audio itself identifies as', () => {
  const RECORDING_MBID = 'b1a9c0de-1111-2222-3333-444455556666';

  it('a recording carried on releases BLOCKS the public path', () => {
    const report = scoreProvenance(untagged, {
      acousticIdentityMatch: {
        recordingMbid: RECORDING_MBID,
        score: 0.973,
        title: 'Por interés',
        artistName: 'Carlota Giró',
        releaseCount: 4,
      },
    });

    expect(report.verdict).toBe('commercial');
    expect(codes(report)).toContain('acoustid.commercial-release');
    const detail = detailOf(report, 'acoustid.commercial-release');
    expect(detail).toContain(RECORDING_MBID);
    expect(detail).toContain('Carlota Giró');
    expect(detail).toContain('4 release entities');
    expect(detail).toContain('0.973');
  });

  it('blocks a file whose tags are otherwise spotless', () => {
    // The point of the whole feature: `indie-id3v2.mp3` scores CLEAN on tags
    // alone. Identifying the audio is the only thing that can contradict them.
    expect(scoreProvenance(indie).verdict).toBe('clean');

    const report = scoreProvenance(indie, {
      acousticIdentityMatch: {
        recordingMbid: RECORDING_MBID,
        score: 0.99,
        releaseCount: 1,
      },
    });

    expect(report.verdict).toBe('commercial');
    expect(detailOf(report, 'acoustid.commercial-release')).toContain('1 release entity');
  });

  it('a recording on NO release is high, not blocking', () => {
    // Genuinely ambiguous: an artist who catalogued their own unreleased work
    // looks exactly like this. It weighs heavily without deciding.
    const report = scoreProvenance(indie, {
      acousticIdentityMatch: {
        recordingMbid: RECORDING_MBID,
        score: 0.95,
        releaseCount: 0,
      },
    });

    expect(codes(report)).toContain('acoustid.known-recording');
    expect(codes(report)).not.toContain('acoustid.commercial-release');
    expect(report.verdict).toBe('suspect');
    expect(report.markers.every((marker) => marker.weight !== 'blocking')).toBe(true);
  });

  it('no identification means no marker — silence is not evidence', () => {
    // The degraded arm. No key, service down, or nothing above the threshold all
    // arrive here as an absent context, and none of them may look like a finding.
    expect(scoreProvenance(indie, {}).markers).toEqual([]);
  });
});

// ── The database-backed collector ───────────────────────────────────────────

describe('collectProvenanceSignals', () => {
  it('resolves the ISRC against IsrcRegistry and returns the row for enrichment', async () => {
    await IsrcRegistryModel.create({
      isrc: 'ESA452300137',
      recordingMbid: '5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7',
      title: 'Midnight Ferry',
      artistCredit: 'Nadia Ortiz',
      artistCreditNameKey: 'nadia ortiz',
      lengthMs: 152_000,
      releaseCount: 4,
    });

    const { report, isrcRegistryMatch } = await collectProvenanceSignals(indie);

    expect(isrcRegistryMatch?.recordingMbid).toBe('5f0a1b2c-3d4e-4f50-8a61-72b3c4d5e6f7');
    expect(isrcRegistryMatch?.releaseCount).toBe(4);
    expect(report.verdict).toBe('commercial');
    expect(codes(report)).toContain('isrc.resolves-to-release');
  });

  it('an ISRC that resolves to nothing leaves the file clean', async () => {
    const { report, isrcRegistryMatch } = await collectProvenanceSignals(indie);

    expect(isrcRegistryMatch).toBeUndefined();
    expect(report.markers).toEqual([]);
    expect(report.verdict).toBe('clean');
  });
});
