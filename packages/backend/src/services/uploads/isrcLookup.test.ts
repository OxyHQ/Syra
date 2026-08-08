/**
 * The uploader's ISRC: what it resolves to, and whether the file agrees.
 *
 * Three things here are worth stating, because they are the assertions that
 * would be worthless written any other way:
 *
 *  - The Deezer parser runs against REAL captured payloads
 *    (`__fixtures__/deezer-payloads.json`), not against an object literal
 *    somebody wrote to match the parser. In particular the unknown-code payload
 *    is a real `200 OK` carrying an error object, which is the shape a parser
 *    that trusted the HTTP status would read as a successful resolution.
 *  - The duration check is tested at and either side of its boundary. A test
 *    that only fed it an obviously wrong length could not tell a working
 *    tolerance from `durationSec > 0`, and widening the tolerance to infinity
 *    must break a NAMED test rather than quietly pass.
 *  - Verification is tested against a file whose title and artist AGREE while
 *    the length does not, and vice versa. Either half alone passing would mean
 *    the other half is inert.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { clearDb, connectDb, disconnectDb } from '../../test/postgres';
import { getDb } from '../../db/postgres';
import { isrcRegistry } from '../../db/schema/catalog';
import {
  ISRC_DURATION_TOLERANCE_SEC,
  parseDeezerAlbumTrackCount,
  parseDeezerTrack,
  resolveIsrc,
  setDeezerFetchForTests,
  verifyIsrcClaim,
} from './isrcLookup';

interface DeezerPayloads {
  producedBy: { capturedAt: string; requests: string[]; note: string };
  trackByIsrc: Record<string, unknown>;
  album: Record<string, unknown>;
  unknownIsrc: Record<string, unknown>;
}

const payloads: DeezerPayloads = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'deezer-payloads.json'), 'utf8'),
);

/** The measured case this feature was built for. */
const ISRC = 'ESA092607944';
const FILE_DURATION_SEC = 191.92;

// ONE database: `isrc_registry` and the upload screening state this suite's
// other fixtures carry are both Postgres since Task 13.
beforeAll(async () => {
  await connectDb();
});
beforeEach(() => setDeezerFetchForTests());
afterEach(async () => {
  setDeezerFetchForTests();
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

/** Answers the track URL from the captured payload and nothing else. */
function serveCapturedDeezer(overrides?: Record<string, unknown>): string[] {
  const requested: string[] = [];
  setDeezerFetchForTests(async (url: string) => {
    requested.push(url);
    if (url.includes(`isrc:${ISRC}`)) return { ...payloads.trackByIsrc, ...overrides };
    if (url.includes('/album/')) return payloads.album;
    return payloads.unknownIsrc;
  });
  return requested;
}

// ── The parser, against what Deezer really sends ────────────────────────────

describe('parseDeezerTrack', () => {
  it('the captured payloads are real and cover both answers', () => {
    // Vacuity floor. Every assertion below reads fields out of these payloads;
    // a fixture that had been reduced to what the parser happens to want would
    // satisfy them all while proving nothing about the real API.
    expect(payloads.producedBy.requests.length).toBe(3);
    expect(Object.keys(payloads.trackByIsrc).length).toBeGreaterThan(15);
    // The unknown-code answer is a 200 with an error object, NOT a 404 — the
    // whole reason the parser reads `error` instead of the status.
    expect(payloads.unknownIsrc.error).toBeTruthy();
  });

  it('reads the six metadata fields, and no image', () => {
    const recording = parseDeezerTrack(payloads.trackByIsrc, ISRC);

    expect(recording).toEqual({
      isrc: ISRC,
      source: 'deezer',
      title: 'Por interés',
      artistName: 'Carlota Giró',
      albumName: 'Por interés',
      releaseDate: '2026-06-26',
      durationSec: 191,
    });

    // Deezer's payload carries five cover URLs and five artist pictures. None of
    // them may travel: their terms cover metadata, cover art is licensed per
    // work, and Syra does not rehost another platform's artwork. A field that
    // does not exist cannot be stored by a later change.
    expect(JSON.stringify(recording)).not.toContain('dzcdn.net');
    expect(JSON.stringify(recording)).not.toContain('picture');
    expect(JSON.stringify(recording)).not.toContain('cover');
  });

  it('reads an unknown code as unresolved, though it answered 200', () => {
    expect(parseDeezerTrack(payloads.unknownIsrc, 'ZZZZZ9900001')).toBeUndefined();
  });

  it('refuses a payload that answers with a DIFFERENT code than the one asked for', () => {
    // The echoed code is the authority. Without this check a redirect, a cache
    // collision or a change in how Deezer resolves `isrc:` lookups would attach
    // another recording's facts to this uploader's claim.
    const answeredWithAnother = { ...payloads.trackByIsrc, isrc: 'GBAYE9800712' };
    expect(parseDeezerTrack(answeredWithAnother, ISRC)).toBeUndefined();
  });

  it('reads the release track count, which the track payload does not carry', () => {
    expect(payloads.trackByIsrc.nb_tracks).toBeUndefined();
    expect(parseDeezerAlbumTrackCount(payloads.album)).toBe(1);
    expect(parseDeezerAlbumTrackCount(payloads.unknownIsrc)).toBeUndefined();
  });
});

// ── Resolution order ────────────────────────────────────────────────────────

describe('resolveIsrc', () => {
  it('answers from the local registry without spending a request', async () => {
    await getDb().insert(isrcRegistry).values({
      isrc: ISRC,
      recordingMbid: 'e0a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7',
      title: 'Por interés',
      artistCredit: 'Carlota Giró',
      artistCreditNameKey: 'carlota giro',
      lengthMs: 191_000,
      releaseCount: 1,
    });
    const requested = serveCapturedDeezer();

    const result = await resolveIsrc(ISRC);

    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.recording.source).toBe('isrc-registry');
    // Free, local and unlimited: the network is not touched when the slice knows
    // the answer, which is what keeps this tier affordable inline.
    expect(requested).toEqual([]);
  });

  it('falls through to Deezer when the registry row cannot state a length', async () => {
    // The distinction the fallthrough exists for: this row identifies the
    // recording, and identifying it is not the same as being able to CHECK it.
    // The duration is the only comparison against something measured from the
    // audio, so a source that has none ends nothing.
    await getDb().insert(isrcRegistry).values({
      isrc: ISRC,
      recordingMbid: 'e0a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7',
      title: 'Por interés',
      artistCredit: 'Carlota Giró',
      artistCreditNameKey: 'carlota giro',
      releaseCount: 1,
    });
    serveCapturedDeezer();

    const result = await resolveIsrc(ISRC);

    expect(result.status === 'found' && result.recording.source).toBe('deezer');
    expect(result.status === 'found' && result.recording.durationSec).toBe(191);
  });

  it('keeps the lengthless registry row when Deezer has nothing either', async () => {
    await getDb().insert(isrcRegistry).values({
      isrc: ISRC,
      recordingMbid: 'e0a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7',
      title: 'Por interés',
      artistCredit: 'Carlota Giró',
      artistCreditNameKey: 'carlota giro',
      releaseCount: 1,
    });
    setDeezerFetchForTests(async () => payloads.unknownIsrc);

    const result = await resolveIsrc(ISRC);

    // Still `found`: the code IS known. It is `verifyIsrcClaim` that decides a
    // recording with no length cannot verify anything, and it says so with its
    // own reason rather than this returning a misleading `not-found`.
    expect(result.status === 'found' && result.recording.source).toBe('isrc-registry');
    expect(result.status === 'found' && result.recording.durationSec).toBeUndefined();
  });

  it('follows the release for its track count', async () => {
    const requested = serveCapturedDeezer();

    const result = await resolveIsrc(ISRC);

    expect(result.status === 'found' && result.recording.totalTracks).toBe(1);
    expect(requested).toHaveLength(2);
    expect(requested[1]).toContain('/album/996677771');
  });

  it('still resolves when the release lookup fails', async () => {
    // Nothing about verification depends on the track count, so a second request
    // that does not come back must not cost the uploader the resolution the
    // first one already produced.
    setDeezerFetchForTests(async (url: string) => {
      if (url.includes('/album/')) throw new Error('Deezer is down');
      return payloads.trackByIsrc;
    });

    const result = await resolveIsrc(ISRC);

    expect(result.status).toBe('found');
    expect(result.status === 'found' && result.recording.totalTracks).toBeUndefined();
  });

  it('reports a transport failure as `unavailable`, never as a negative answer', async () => {
    setDeezerFetchForTests(async () => {
      throw new Error('ECONNRESET');
    });

    const result = await resolveIsrc(ISRC);

    // The distinction the whole degraded-mode discipline rests on: nothing was
    // learned, so nothing may be concluded. A caller that read this as
    // "not found" would refuse a legitimate claim for an outage.
    expect(result.status).toBe('unavailable');
  });

  it('caches an answer, and never caches an outage', async () => {
    const requested = serveCapturedDeezer();
    await resolveIsrc(ISRC);
    await resolveIsrc(ISRC);
    // Two requests for the first resolution (track, then release), none for the
    // second — the whole point of a per-ISRC cache on a rate-limited source.
    expect(requested).toHaveLength(2);

    let attempts = 0;
    setDeezerFetchForTests(async () => {
      attempts += 1;
      throw new Error('ECONNRESET');
    });
    await resolveIsrc('GBAYE9800712');
    await resolveIsrc('GBAYE9800712');
    // A failure cached for a day would refuse every later upload of a recording
    // that resolves perfectly well.
    expect(attempts).toBe(2);
  });

  it('refuses to build a URL from a malformed code', async () => {
    let requested = false;
    setDeezerFetchForTests(async () => {
      requested = true;
      return payloads.unknownIsrc;
    });

    // Unreachable through the API — `isrcSchema` rejects this with a 400 — so
    // what is asserted is that the failure mode is CLOSED rather than a request
    // built from whatever a future caller passed.
    const result = await resolveIsrc('../../etc/passwd');

    expect(result.status).toBe('not-found');
    expect(requested).toBe(false);
  });
});

// ── Verification ────────────────────────────────────────────────────────────

describe('verifyIsrcClaim', () => {
  /** The file that prompted this feature: real tags, no ISRC frame. */
  const FILE = {
    durationSec: FILE_DURATION_SEC,
    title: 'Por interés',
    artistName: 'Carlota Giró',
  };

  it('accepts the measured case: 191.92 s of audio against a 191 s registration', async () => {
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, FILE);

    expect(verdict.status).toBe('verified');
    expect(verdict.status === 'verified' && verdict.recording.albumName).toBe('Por interés');
    expect(verdict.status === 'verified' && verdict.recording.releaseDate).toBe('2026-06-26');
  });

  it('accepts a hyphenated code, which is how the code is printed', async () => {
    serveCapturedDeezer();

    expect((await verifyIsrcClaim('ES-A09-26-07944', FILE)).status).toBe('verified');
  });

  it('accepts when only the ARTIST agrees', async () => {
    // Either half suffices on purpose: a title differs between a release and a
    // distributor's database far more often than an artist is wrong, and
    // requiring both would refuse correct codes for a formatting difference.
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, { ...FILE, title: 'Track 01' });

    expect(verdict.status).toBe('verified');
  });

  it('accepts when only the TITLE agrees', async () => {
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, { ...FILE, artistName: undefined });

    expect(verdict.status).toBe('verified');
  });

  it('matches a credit against its principal artist', async () => {
    // `Carlota Giró feat. Someone` in the file against `Carlota Giró` in the
    // source is an agreement, through the codebase's one credit splitter.
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, {
      ...FILE,
      title: 'Track 01',
      artistName: 'Carlota Giró feat. Kofi Mensah',
    });

    expect(verdict.status).toBe('verified');
  });

  it('matches an unaccented spelling, through the shared name key', async () => {
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, {
      ...FILE,
      title: 'Track 01',
      artistName: 'CARLOTA GIRO',
    });

    expect(verdict.status).toBe('verified');
  });

  /**
   * THE MUTATION-TEST TARGET.
   *
   * The only thing wrong with this claim is the length: the title and the artist
   * both agree, so the name half of the rule passes and the duration check is
   * the sole reason for the refusal. Widen `ISRC_DURATION_TOLERANCE_SEC` to
   * `Infinity` and this test — and only this test — turns from `mismatch` into
   * `verified`. That is what makes the tolerance a check rather than a decoration.
   */
  it('refuses a code registered to the right name at the WRONG LENGTH', async () => {
    serveCapturedDeezer({ duration: 191 + ISRC_DURATION_TOLERANCE_SEC + 1 });

    const verdict = await verifyIsrcClaim(ISRC, FILE);

    expect(verdict.status).toBe('mismatch');
    expect(verdict.status === 'mismatch' && verdict.disagreed).toEqual(['duration']);
  });

  it('accepts a length exactly ON the tolerance and refuses one just past it', async () => {
    // At and either side of the boundary. Without this a tolerance of zero and a
    // tolerance of thirty would both pass every other test in this block.
    serveCapturedDeezer({ duration: FILE_DURATION_SEC + ISRC_DURATION_TOLERANCE_SEC });
    expect((await verifyIsrcClaim(ISRC, FILE)).status).toBe('verified');

    serveCapturedDeezer({ duration: FILE_DURATION_SEC + ISRC_DURATION_TOLERANCE_SEC + 0.01 });
    expect((await verifyIsrcClaim(ISRC, FILE)).status).toBe('mismatch');
  });

  it('refuses a code that resolves to somebody else’s recording entirely', async () => {
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, {
      durationSec: 240,
      title: 'Midnight Ferry',
      artistName: 'Nadia Ortiz',
    });

    expect(verdict.status).toBe('mismatch');
    // Both halves failed, and both are reported: the uploader is owed the whole
    // comparison, not the first field that happened to disagree.
    expect(verdict.status === 'mismatch' && verdict.disagreed).toEqual([
      'duration',
      'title',
      'artist',
    ]);
    expect(verdict.status === 'mismatch' && verdict.recording.title).toBe('Por interés');
  });

  it('refuses a file that declares NEITHER a title nor an artist', async () => {
    // The duration alone is not an identification: the tolerance admits a window
    // that thousands of unrelated recordings sit in. A stripped file has nothing
    // to corroborate a typed code with, and is told so.
    serveCapturedDeezer();

    const verdict = await verifyIsrcClaim(ISRC, { durationSec: FILE_DURATION_SEC });

    expect(verdict.status).toBe('mismatch');
    expect(verdict.status === 'mismatch' && verdict.disagreed).toEqual(['title', 'artist']);
  });

  it('does not let two blanks agree with each other', async () => {
    // A file that names nobody against a registration that names nobody must not
    // match by both being empty — that would make every stripped file verify
    // against every anonymous registration, on the duration alone.
    serveCapturedDeezer({ title: '', artist: {} });

    const verdict = await verifyIsrcClaim(ISRC, { durationSec: FILE_DURATION_SEC });

    expect(verdict.status).toBe('mismatch');
    expect(verdict.status === 'mismatch' && verdict.disagreed).toEqual(['title', 'artist']);
  });

  it('reports a code no source knows as UNVERIFIABLE, not as a mismatch', async () => {
    // Nothing was contradicted. The code may well be real and simply absent from
    // both sources, which is a different thing to tell the uploader — and a
    // different fix.
    setDeezerFetchForTests(async () => payloads.unknownIsrc);

    const verdict = await verifyIsrcClaim('ZZZZZ9900001', FILE);

    expect(verdict.status).toBe('unverifiable');
  });

  it('reports an OUTAGE as unverifiable — never as a pass', async () => {
    // The direction that matters: a source being down must not become a way to
    // have any twelve characters accepted.
    setDeezerFetchForTests(async () => {
      throw new Error('ECONNRESET');
    });

    expect((await verifyIsrcClaim(ISRC, FILE)).status).toBe('unverifiable');
  });

  it('reports a source that knows the code but not its length as unverifiable', async () => {
    await getDb().insert(isrcRegistry).values({
      isrc: ISRC,
      recordingMbid: 'e0a1b2c3-d4e5-4f60-8a71-92b3c4d5e6f7',
      title: 'Por interés',
      artistCredit: 'Carlota Giró',
      artistCreditNameKey: 'carlota giro',
      releaseCount: 1,
    });
    setDeezerFetchForTests(async () => payloads.unknownIsrc);

    const verdict = await verifyIsrcClaim(ISRC, FILE);

    // The names agree perfectly. It is still not verified, because the names are
    // read from tags the same person could have written, and the length is the
    // only comparison against the audio itself.
    expect(verdict.status).toBe('unverifiable');
  });
});
