/**
 * AcoustID identification: the encoder, the client, and what the client is
 * allowed to conclude.
 *
 * Two of these deserve saying out loud, because they are the assertions that
 * would be worthless if written any other way:
 *
 *  - The Chromaprint compressor is checked against `fpcalc`'s OWN output for the
 *    same audio, not against a value this module produced earlier. An encoder
 *    tested against itself passes forever while sending the API something it
 *    cannot decode, and the failure would look exactly like "AcoustID never
 *    matches anything".
 *  - The threshold is tested at and either side of the boundary. A test that only
 *    fed it an obvious match could not tell a working threshold from `score > 0`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { clear, connect, disconnect } from '../../test/mongo';
import { env } from '../../config/env';
import { IsrcRegistryModel } from '../../models/IsrcRegistry';
import {
  ACOUSTID_MATCH_SCORE,
  ACOUSTID_MAX_QUEUE_WAIT_MS,
  ACOUSTID_MIN_REQUEST_INTERVAL_MS,
  encodeChromaprint,
  identifyRecording,
  lookupByFingerprint,
  parseAcoustidResponse,
  requestAcoustidLookup,
  resetAcoustidRateLimitForTests,
  resolveAcousticIdentity,
  setAcoustidFetchForTests,
  type AcoustidRecording,
} from './acoustid';
import { FINGERPRINT_MATCH_BER } from './fingerprint';

interface ChromaprintCase {
  name: string;
  source: string;
  durationSec: number;
  values: number[];
  compressed: string;
}

const groundTruth: { cases: ChromaprintCase[]; producedBy: Record<string, string> } = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'chromaprint-compressed.json'), 'utf8'),
);

beforeAll(connect);
beforeEach(resetAcoustidRateLimitForTests);
afterEach(async () => {
  setAcoustidFetchForTests();
  await clear();
});
afterAll(disconnect);

// ── The encoder ─────────────────────────────────────────────────────────────

describe('encodeChromaprint reproduces fpcalc byte for byte', () => {
  it('the ground truth is real and covers both branches', () => {
    // Vacuity floor. Every assertion below is "our output equals the fixture's",
    // which an empty or single-sample fixture would satisfy trivially — and the
    // escape branch is content-dependent, so a corpus that never overflows the
    // 3-bit stream cannot tell a working escape path from a missing one.
    expect(groundTruth.cases.length).toBeGreaterThanOrEqual(4);
    expect(groundTruth.producedBy.fpcalc).toContain('fpcalc');

    const lengths = groundTruth.cases.map((entry) => entry.compressed.length);
    // `noEscapes` is short because nothing overflows; `manyEscapes` is long
    // because 89 values do. If the corpus ever collapses to one shape this fails.
    expect(Math.max(...lengths)).toBeGreaterThan(Math.min(...lengths) * 2);
    for (const entry of groundTruth.cases) {
      expect(entry.values.length).toBeGreaterThan(100);
    }
  });

  for (const entry of groundTruth.cases) {
    it(`${entry.name} (${entry.values.length} items)`, () => {
      expect(encodeChromaprint(entry.values)).toBe(entry.compressed);
    });
  }

  it('is sensitive to every value — a single flipped bit changes the output', () => {
    // Mutation test on the fixture rather than on the code: this is what proves
    // the comparison above is doing work. An encoder that returned a constant,
    // or that dropped the tail, would pass every assertion above on a lucky
    // corpus and fail here.
    const [first] = groundTruth.cases;
    const mutated = [...first.values];
    mutated[mutated.length - 1] ^= 1;
    expect(encodeChromaprint(mutated)).not.toBe(first.compressed);

    const truncated = first.values.slice(0, -1);
    expect(encodeChromaprint(truncated)).not.toBe(first.compressed);
  });

  it('encodes an empty fingerprint as a bare header rather than throwing', () => {
    // Four header bytes, no streams. `lookupByFingerprint` refuses to SEND this,
    // but the encoder must not be the thing that explodes.
    expect(encodeChromaprint([])).toBe('AQAAAA');
  });

  it('emits base64url with no padding, which is what the API accepts', () => {
    // Not cosmetic. `+` and `/` are `%`-escaped in a form body and `=` is
    // ambiguous there; chromaprint's own encoder uses the URL alphabet unpadded,
    // and the ground-truth comparisons above only cover this incidentally.
    for (const entry of groundTruth.cases) {
      expect(entry.compressed).not.toMatch(/[+/=]/);
    }
    expect(encodeChromaprint([])).not.toMatch(/=/);
  });
});

// ── Degraded mode ───────────────────────────────────────────────────────────

describe('no API key is a result, not a crash', () => {
  it('returns `unavailable` and names the missing key', async () => {
    expect(
      env.ACOUSTID_API_KEY,
      'This assertion is about the UNCONFIGURED path. Unset ACOUSTID_API_KEY to run the suite.',
    ).toBeUndefined();

    const result = await lookupByFingerprint({ values: [1, 2, 3], durationSec: 30 });

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toContain('ACOUSTID_API_KEY');
  });

  it('identifyRecording answers `undefined` rather than propagating it', async () => {
    // The whole point of the degraded arm: callers see "nothing new", so every
    // gate downstream behaves exactly as it did before this feature existed.
    expect(await identifyRecording({ values: [1, 2, 3], durationSec: 30 })).toBeUndefined();
  });

  it('refuses to spend a request on a fingerprint with no values', async () => {
    let called = false;
    setAcoustidFetchForTests(async () => {
      called = true;
      return { status: 'ok', results: [] };
    });

    const result = await requestAcoustidLookup('test-key', { values: [], durationSec: 30 });

    expect(result.status).toBe('unavailable');
    expect(called).toBe(false);
  });
});

// ── The threshold ───────────────────────────────────────────────────────────

function matchPayload(score: number, extra: Record<string, unknown> = {}): unknown {
  return {
    status: 'ok',
    results: [
      {
        id: 'e7d1b7dc-9d1e-4a1f-9f0a-2f3a1b6c8d90',
        score,
        recordings: [
          {
            id: 'b1a9c0de-1111-2222-3333-444455556666',
            title: 'Midnight Ferry',
            duration: 214,
            artists: [{ id: 'aaaa1111-2222-3333-4444-555566667777', name: 'Nadia Ortiz' }],
            ...extra,
          },
        ],
      },
    ],
  };
}

describe('the score threshold', () => {
  it('is the complement of the measured local BER, not a round number', () => {
    // The coupling IS the justification: the local comparator and the remote
    // index must call the same pair of fingerprints the same thing. If somebody
    // recalibrates FINGERPRINT_MATCH_BER against a new corpus, this moves with it.
    expect(ACOUSTID_MATCH_SCORE).toBe(1 - FINGERPRINT_MATCH_BER);
    expect(ACOUSTID_MATCH_SCORE).toBeCloseTo(0.9, 10);
  });

  it('a below-threshold score is NOT a match', () => {
    const result = parseAcoustidResponse(matchPayload(ACOUSTID_MATCH_SCORE - 0.0001));

    expect(result.status).toBe('no-match');
    if (result.status !== 'no-match') throw new Error('unreachable');
    // The score still travels, so "we looked and the best was 0.9" is
    // distinguishable from "we did not look".
    expect(result.bestScore).toBeCloseTo(ACOUSTID_MATCH_SCORE - 0.0001, 6);
  });

  it('a score exactly at the threshold IS a match', () => {
    const result = parseAcoustidResponse(matchPayload(ACOUSTID_MATCH_SCORE));
    expect(result.status).toBe('match');
  });

  it('a plainly unrelated score is not dragged over the line by anything else', () => {
    expect(parseAcoustidResponse(matchPayload(0.42)).status).toBe('no-match');
  });
});

// ── Parsing ─────────────────────────────────────────────────────────────────

describe('parseAcoustidResponse', () => {
  it('reads the recording, its artist and its releases', () => {
    const result = parseAcoustidResponse(
      matchPayload(0.98, {
        releases: [{ id: 'r-1' }, { id: 'r-2' }],
        releasegroups: [{ id: 'rg-1' }],
      }),
    );

    expect(result.status).toBe('match');
    if (result.status !== 'match') throw new Error('unreachable');
    expect(result.recording.recordingMbid).toBe('b1a9c0de-1111-2222-3333-444455556666');
    expect(result.recording.title).toBe('Midnight Ferry');
    expect(result.recording.artists).toEqual([
      { mbid: 'aaaa1111-2222-3333-4444-555566667777', name: 'Nadia Ortiz' },
    ]);
    expect(result.recording.releaseMbids).toEqual(['r-1', 'r-2']);
    expect(result.recording.releaseGroupMbids).toEqual(['rg-1']);
    expect(result.recording.durationSec).toBe(214);
  });

  it('finds releases nested at the RESULT level too', () => {
    // The one field in this payload whose misreading changes a safety outcome:
    // releases absent reads as "not commercially released", which downgrades a
    // blocking marker to a merely high one. Both nestings are accepted rather
    // than one being assumed, because this could not be verified against a live
    // keyed response.
    const payload = {
      status: 'ok',
      results: [
        {
          id: 'acoustid-1',
          score: 0.99,
          releases: [{ id: 'r-9' }],
          recordings: [{ id: 'rec-1' }],
        },
      ],
    };

    const result = parseAcoustidResponse(payload);
    expect(result.status).toBe('match');
    if (result.status !== 'match') throw new Error('unreachable');
    expect(result.recording.releaseMbids).toEqual(['r-9']);
  });

  it('a high-scoring result with no recordings identifies nothing', () => {
    // A fingerprint AcoustID knows but nobody linked to MusicBrainz. There is no
    // recording to name, so there is nothing to conclude — and concluding
    // anything here would be a marker with no evidence behind it.
    const result = parseAcoustidResponse({
      status: 'ok',
      results: [{ id: 'acoustid-1', score: 0.99, recordings: [] }],
    });

    expect(result.status).toBe('no-match');
    if (result.status !== 'no-match') throw new Error('unreachable');
    expect(result.bestScore).toBe(0.99);
  });

  it('prefers the best-scoring result', () => {
    const result = parseAcoustidResponse({
      status: 'ok',
      results: [
        { id: 'low', score: 0.91, recordings: [{ id: 'rec-low' }] },
        { id: 'high', score: 0.97, recordings: [{ id: 'rec-high' }] },
      ],
    });

    expect(result.status).toBe('match');
    if (result.status !== 'match') throw new Error('unreachable');
    expect(result.recording.recordingMbid).toBe('rec-high');
  });

  it('an API error envelope is `unavailable`, never `no-match`', () => {
    // Captured live from api.acoustid.org on 2026-08-02 by sending a bad key.
    // The distinction is the whole degraded-mode contract: "the service refused
    // us" must never be recorded as "this audio is not a known recording".
    const result = parseAcoustidResponse({
      status: 'error',
      error: { code: 4, message: 'invalid API key' },
    });

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toContain('invalid API key');
    expect(result.reason).toContain('code 4');
  });

  it('a body that is not an object is `unavailable`', () => {
    expect(parseAcoustidResponse('<html>502</html>').status).toBe('unavailable');
    expect(parseAcoustidResponse(null).status).toBe('unavailable');
  });

  it('an ok response with no results is a genuine negative', () => {
    expect(parseAcoustidResponse({ status: 'ok', results: [] }).status).toBe('no-match');
  });
});

// ── The request ─────────────────────────────────────────────────────────────

describe('the request the service actually receives', () => {
  it('carries the key, the compressed fingerprint and an integer duration', async () => {
    let sent: URLSearchParams | undefined;
    setAcoustidFetchForTests(async (body) => {
      sent = body;
      return { status: 'ok', results: [] };
    });

    const [sample] = groundTruth.cases;
    await requestAcoustidLookup('client-key-1', {
      values: sample.values,
      durationSec: 214.6,
    });

    if (!sent) throw new Error('the lookup made no request');
    expect(sent.get('client')).toBe('client-key-1');
    expect(sent.get('format')).toBe('json');
    // `recordings`, not `recordingids`: the artist MBID is the identifier the
    // whole feature exists to recover, and `recordingids` returns no artists.
    expect(sent.get('meta')).toContain('recordings');
    expect(sent.get('meta')).toContain('releaseids');
    expect(sent.get('meta')).toContain('releasegroupids');
    // AcoustID buckets its index by duration and rejects a fractional value.
    expect(sent.get('duration')).toBe('215');
    expect(sent.get('fingerprint')).toBe(sample.compressed);
  });

  it('a network failure degrades to `unavailable`', async () => {
    setAcoustidFetchForTests(async () => {
      throw new Error('AcoustID responded 503');
    });

    const result = await requestAcoustidLookup('client-key-1', { values: [1, 2], durationSec: 30 });

    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('unreachable');
    expect(result.reason).toContain('503');
  });

  it('gives up rather than queueing past what an upload may wait', async () => {
    // The property that makes an inline call safe. The answer is needed BEFORE
    // the upload is accepted or refused, so the call cannot be deferred to a
    // queue — the protection is that it is BOUNDED. Past the bound the request
    // is never made and the caller gets `unavailable`, which it already handles.
    setAcoustidFetchForTests(async () => ({ status: 'ok', results: [] }));

    const budget = Math.floor(ACOUSTID_MAX_QUEUE_WAIT_MS / ACOUSTID_MIN_REQUEST_INTERVAL_MS) + 1;
    const fingerprint = { values: [1, 2, 3], durationSec: 30 };

    // Fired together so the reservations are taken in one burst, the way a
    // batch of concurrent uploads would take them.
    const results = await Promise.all(
      Array.from({ length: budget + 1 }, () => requestAcoustidLookup('client-key-1', fingerprint)),
    );

    expect(results.filter((result) => result.status === 'no-match').length).toBe(budget);
    const refused = results.filter((result) => result.status === 'unavailable');
    expect(refused.length).toBe(1);
    if (refused[0]?.status !== 'unavailable') throw new Error('unreachable');
    expect(refused[0].reason).toContain('may wait');
  });
});

// ── Identity ────────────────────────────────────────────────────────────────

describe('resolveAcousticIdentity turns a match into identifiers', () => {
  const RECORDING_MBID = 'b1a9c0de-1111-2222-3333-444455556666';

  const matched = (overrides: Partial<AcoustidRecording> = {}): AcoustidRecording => ({
    acoustid: 'e7d1b7dc-9d1e-4a1f-9f0a-2f3a1b6c8d90',
    score: 0.97,
    recordingMbid: RECORDING_MBID,
    title: 'Midnight Ferry',
    artists: [{ mbid: 'aaaa1111-2222-3333-4444-555566667777', name: 'Nadia Ortiz' }],
    releaseMbids: [],
    releaseGroupMbids: [],
    ...overrides,
  });

  async function seedRegistry(): Promise<void> {
    await IsrcRegistryModel.create({
      isrc: 'ESA452300137',
      recordingMbid: RECORDING_MBID,
      title: 'Midnight Ferry',
      artistCredit: 'Nadia Ortiz',
      artistCreditNameKey: 'nadia ortiz',
      releaseCount: 3,
    });
  }

  it('recovers the ISRC from the local MusicBrainz slice', async () => {
    // THE rescue this feature exists for: the file carried no ISRC, the audio
    // resolved to a recording, and the recording has one.
    await seedRegistry();

    const identity = await resolveAcousticIdentity(matched());

    expect(identity.isrc).toBe('ESA452300137');
    expect(identity.musicbrainzArtistId).toBe('aaaa1111-2222-3333-4444-555566667777');
    expect(identity.artistName).toBe('Nadia Ortiz');
    expect(identity.recordingMbid).toBe(RECORDING_MBID);
  });

  it('still identifies the recording when the slice has never been imported', async () => {
    // `scripts/importIsrcRegistry.ts` is a manual monthly job, so an empty
    // collection is a normal state. The identification and therefore the markers
    // must not depend on it — only the ISRC recovery does.
    const identity = await resolveAcousticIdentity(matched({ releaseMbids: ['r-1'] }));

    expect(identity.isrc).toBeUndefined();
    expect(identity.recordingMbid).toBe(RECORDING_MBID);
    expect(identity.releaseCount).toBe(1);
  });

  it('counts releases and release groups as one set of release entities', async () => {
    // A release group IS a release entity; a recording carrying only a group is
    // still a recording somebody released. Counting only pressings would let
    // that case through as "known but unreleased".
    const identity = await resolveAcousticIdentity(
      matched({ releaseMbids: ['r-1', 'r-2'], releaseGroupMbids: ['rg-1'] }),
    );

    expect(identity.releaseCount).toBe(3);
    expect(identity.releaseMbid).toBe('r-1');
    expect(identity.releaseGroupMbid).toBe('rg-1');
  });

  it('reports no releases when the recording carries none', async () => {
    expect((await resolveAcousticIdentity(matched())).releaseCount).toBe(0);
  });

  it('the registry read is served by an index, not a collection scan', async () => {
    await seedRegistry();

    // The reverse direction (recording → ISRC) is what this feature added. Without
    // the index it is a scan over the whole MusicBrainz slice, on the upload path
    // with a person waiting.
    const indexes = await IsrcRegistryModel.collection.indexes();
    expect(indexes.some((index) => index.key.recordingMbid === 1)).toBe(true);
  });
});
