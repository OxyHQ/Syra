import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { connect, clear, disconnect } from '../test/mongo';
import { ArtistModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import { UserUploadModel } from '../models/UserUpload';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { formatTracksWithCoverArt, formatArtistWithImage } from '../utils/musicHelpers';
import { toUploadTrackDto } from './uploads.controller';
import { getEntityProfile } from './entityProfile.controller';
import { getArtistById, getMyContributions, getMyImageSuggestions } from './artists.controller';

/**
 * ONE test for a whole class of leak, rather than N ad-hoc ones.
 *
 * THE CLASS: a field believed private because it is `select: false` and/or absent
 * from a zod schema, reachable on a route that either
 *   (a) reads through an AGGREGATION — which ignores `select: false` outright, or
 *   (b) serialises by SPREADING a document through an untyped formatter — which
 *       ignores the schema.
 * Either condition alone defeats BOTH guards.
 *
 * This is not hypothetical. `CatalogEntity.imageSuggestions` met both: the
 * catalog helpers read artists with `aggregate()`, `formatArtistWithImage` spreads
 * through `toApiFormat`, and `GET /api/artists/:id` served pending profile photos —
 * guesses about what a real person looks like — to anyone, for any artist with a
 * playable track.
 *
 * WHICH GUARD HOLDS WHERE, measured by removing each one and re-running:
 *   - catalog reads    -> `stripExternalCatalogFields` (a denylist). Removing
 *     `select: false` from `Track.sha256` leaked it from ELEVEN handlers at once,
 *     so the strip is the guard that survives a read becoming an aggregation.
 *   - the locker       -> `toUploadTrackDto`, an explicit object literal (an
 *     ALLOWLIST — strictly stronger: a field added to `UserUpload` tomorrow is
 *     excluded by default). No `delete` exists for it, deliberately: a delete on a
 *     serializer that never names the field can never fire, and would advertise a
 *     denylist where the real guard is an allowlist.
 *   - attestations     -> the `$lookup` projects two fields and no more.
 *
 * NOT a leak, and must not be "fixed" into one: `CatalogEntity.imageLicence` is
 * public on purpose. CC BY-SA is satisfied BY displaying the author and licence;
 * hiding it would be the breach.
 *
 * Every assertion below states the value AND the field name, and every one is
 * preceded by a vacuity floor — the secret really is stored, and the endpoint
 * really answered 200 with the right entity. The first version of this file
 * passed while the guard was removed, because the fixture artist had no tracks
 * and the route 404'd.
 */

beforeAll(connect);
afterEach(clear);
afterAll(disconnect);

interface CapturedRes {
  _status: number;
  _body: unknown;
  status(code: number): CapturedRes;
  json(body: unknown): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    _status: 200,
    _body: undefined,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

const failNext: NextFunction = (err) => { throw err; };

function makeReq(userId: string, body: unknown = {}, params: Record<string, string> = {}): AuthRequest {
  return { params, query: {}, body, user: { id: userId } } as unknown as AuthRequest;
}

const OWNER = 'the-artist';
const COMMONS_URL = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg';
const EMBEDDED_URL = 'https://syra.example/embedded/cover.jpg';

const COMMONS_SUGGESTION = {
  image: {
    origin: 'external' as const,
    url: COMMONS_URL,
    width: 800,
    height: 800,
    provider: 'wikimedia-commons' as const,
    licence: {
      licence: 'CC-BY-SA-4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'Jane Photographer',
      sourceUrl: 'https://commons.wikimedia.org/wiki/File:Artist.jpg',
    },
  },
  proposedAt: new Date('2026-07-01T00:00:00.000Z'),
};

const EMBEDDED_SUGGESTION = {
  image: { origin: 'upload' as const, url: EMBEDDED_URL, width: 500, height: 500 },
  proposedAt: new Date('2026-07-02T00:00:00.000Z'),
  proposedByOxyUserId: 'a-stranger',
  sourceUploadId: '6a6d000000000000000000aa',
};

async function makeArtistWithSuggestions(
  suggestions: Record<string, unknown>[] = [COMMONS_SUGGESTION, EMBEDDED_SUGGESTION],
): Promise<string> {
  const artist = await ArtistModel.create({
    name: `Suggested ${Math.random().toString(36).slice(2)}`,
    source: 'upload',
    origin: 'contributed',
    ownerOxyUserId: OWNER,
    claimedByOxyUserId: OWNER,
    claimable: false,
    imageSuggestions: suggestions,
  });
  /**
   * A PLAYABLE track, and it is load-bearing rather than scenery: the public
   * artist endpoint resolves through `findOneArtistWithPlayableTracks`, so an
   * artist with no catalogue 404s — and every "the secret did not leak"
   * assertion would then pass against an empty error body, proving nothing.
   */
  await TrackModel.create({
    title: 'Something Playable',
    artistId: artist._id.toString(),
    artistName: artist.name,
    duration: 180,
    source: 'upload',
    status: 'ready',
    isAvailable: true,
  });
  return artist._id.toString();
}

describe('suggestions never reach a public surface', () => {
  it('are absent from GET /api/artists/:id', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await getArtistById(
      { params: { id: artistId }, query: {} } as unknown as AuthRequest,
      res as unknown as Response,
      failNext,
    );

    // The endpoint must actually have ANSWERED — a 404 body contains no
    // suggestion either, and would make the assertion below meaningless.
    expect(res._status).toBe(200);
    expect((res._body as { id?: string }).id).toBe(artistId);
    expect(JSON.stringify(res._body)).not.toContain('upload.wikimedia.org');
    expect(JSON.stringify(res._body)).not.toContain('imageSuggestions');
  });

  it('are absent from the entity profile at GET /api/p/:id', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await getEntityProfile(
      { params: { id: artistId }, query: {} } as unknown as AuthRequest,
      res as unknown as Response,
      failNext,
    );

    expect((res._body as { data?: { id?: string } }).data?.id).toBe(artistId);
    expect(JSON.stringify(res._body)).not.toContain('upload.wikimedia.org');
    expect(JSON.stringify(res._body)).not.toContain('imageSuggestions');
  });

  /**
   * Vacuity floor: the two absence checks above would pass just as well against
   * an artist that never had a suggestion. This proves the fixture really has
   * them and that the claim endpoint really can see them.
   */
  it('but the owner CAN see them — so the absences above mean something', async () => {
    await makeArtistWithSuggestions();

    const res = makeRes();
    await getMyImageSuggestions(makeReq(OWNER), res as unknown as Response, failNext);

    expect(JSON.stringify(res._body)).toContain('upload.wikimedia.org');
  });
});
describe('server-only fields never reach a catalog response', () => {
  const SERVER_ONLY = [
    { field: 'imageSuggestions', marker: 'upload.wikimedia.org' },
    { field: 'sha256', marker: 'SHA256SERVERONLYMARKER' },
  ];

  it('strips every one of them from the public artist and track reads', async () => {
    const artistId = await makeArtistWithSuggestions();
    await TrackModel.updateMany({ artistId }, { $set: { sha256: 'SHA256SERVERONLYMARKER' } });

    // Vacuity floor: the values must really be stored, or "absent" proves nothing.
    const stored = await TrackModel.findOne({ artistId }).select('+sha256').lean();
    expect(stored?.sha256).toBe('SHA256SERVERONLYMARKER');
    const storedArtist = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    expect(storedArtist?.imageSuggestions).toHaveLength(2);

    const artistRes = makeRes();
    await getArtistById(
      { params: { id: artistId }, query: {} } as unknown as AuthRequest,
      artistRes as unknown as Response,
      failNext,
    );
    const profileRes = makeRes();
    await getEntityProfile(
      { params: { id: artistId }, query: {} } as unknown as AuthRequest,
      profileRes as unknown as Response,
      failNext,
    );

    // Both must have ANSWERED — a 404 body contains no secret either.
    expect(artistRes._status).toBe(200);
    expect((artistRes._body as { id?: string }).id).toBe(artistId);
    expect((profileRes._body as { data?: { music?: { tracks?: unknown[] } } }).data?.music?.tracks?.length)
      .toBeGreaterThan(0);

    for (const { field, marker } of SERVER_ONLY) {
      for (const [label, res] of [['artist', artistRes], ['profile', profileRes]] as const) {
        const json = JSON.stringify(res._body);
        expect(`${label}:${field}:${json.includes(field)}`).toBe(`${label}:${field}:false`);
        expect(`${label}:${field}:${json.includes(marker)}`).toBe(`${label}:${field}:false`);
      }
    }
  });

  /**
   * The route test above passes today because of `select: false`, NOT because of
   * the strip — removing the strip alone does not break it, because track reads
   * are currently queries. That makes the strip defence for a path that does not
   * exist yet, and an untested defence is the one that gets deleted as dead code.
   *
   * So this tests the FUNNEL directly, with a document shaped the way an
   * aggregation returns one: fields present, projection never applied. It is the
   * `imageSuggestions` failure reproduced in miniature, and it fails the moment
   * either strip is removed.
   */
  it('strips server-only fields from a document an AGGREGATION would produce', async () => {
    const artistId = await makeArtistWithSuggestions();
    const artistDoc = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    const trackDoc = await TrackModel.findOne({ artistId }).lean();

    // Vacuity floor, before the assertions: both documents must exist, or every
    // `not.toContain` below passes against `undefined` and proves nothing.
    if (!artistDoc || !trackDoc) {
      throw new Error('fixture produced no artist/track — the leak assertions would be vacuous');
    }

    // An aggregation ignores `select: false`, so the fields are simply THERE.
    const asAggregated = {
      ...trackDoc,
      sha256: 'SHA256FUNNELMARKER',
    };
    const formattedTrack = await formatTracksWithCoverArt([asAggregated]);
    expect(JSON.stringify(formattedTrack)).not.toContain('SHA256FUNNELMARKER');
    expect(JSON.stringify(formattedTrack)).not.toContain('sha256');

    const formattedArtist = formatArtistWithImage(artistDoc);
    expect(JSON.stringify(formattedArtist)).not.toContain('imageSuggestions');
    expect(JSON.stringify(formattedArtist)).not.toContain('upload.wikimedia.org');

    // Vacuity floor: the formatters really did return the entities.
    expect((formattedTrack[0] as { id?: string }).id).toBe(trackDoc?._id.toString());
    expect((formattedArtist as { id?: string }).id).toBe(artistId);
  });

  /**
   * The LOCKER half of the same class, pinned here rather than left to a one-off
   * sweep.
   *
   * `toUploadTrackDto` is an explicit object literal — every key written out, no
   * spread, no `schema.parse()`, no `passthrough`. That is an ALLOWLIST, which is
   * strictly stronger than the catalog funnel's denylist: a field added to
   * `UserUpload` tomorrow is excluded by default instead of needing somebody to
   * remember a `delete`.
   *
   * The thing that can silently destroy that property is somebody "simplifying"
   * the literal into a spread. This test is what fails when they do, and it is
   * why no `delete upload.rawTags` was added anywhere — a delete on a serializer
   * that never names the field is a line that can never fire, and it would imply
   * a denylist where the real guard is an allowlist.
   */
  it('the locker DTO names only public fields — no storage key, hash, tags or owner id', async () => {
    const upload = await UserUploadModel.create({
      ownerOxyUserId: 'OWNERIDLEAKMARKER',
      title: 'Locker File',
      duration: 200,
      sizeBytes: 1,
      sha256: 'SHA256LEAKMARKER',
      status: 'ready',
      audioSource: { key: 'uploads/OWNERIDLEAKMARKER/AUDIOKEYLEAKMARKER.mp3', format: 'mp3' },
      hlsMasterKey: 'hls/uploads/OWNERIDLEAKMARKER/HLSLEAKMARKER/master.m3u8',
      hls: [{ manifestKey: 'hls/uploads/OWNERIDLEAKMARKER/HLSLEAKMARKER/160/index.m3u8', bitrateKbps: 160, encrypted: true }],
      fingerprint: [1, 2, 3],
      fingerprintDurationSec: 200,
      rawTags: { json: JSON.stringify({ apID: 'APIDLEAKMARKER' }), truncated: false, originalByteLength: 42 },
    });

    // Vacuity floor: every secret really is stored on the document.
    const stored = await UserUploadModel.findById(upload._id).select('+rawTags').lean();
    expect(stored?.rawTags?.json).toContain('APIDLEAKMARKER');
    expect(stored?.sha256).toBe('SHA256LEAKMARKER');
    expect(stored?.audioSource?.key).toContain('AUDIOKEYLEAKMARKER');

    const dto = JSON.stringify(toUploadTrackDto(upload));

    // The DTO answered with the real file — otherwise the absences prove nothing.
    expect(dto).toContain('Locker File');

    for (const marker of [
      'APIDLEAKMARKER', 'SHA256LEAKMARKER', 'AUDIOKEYLEAKMARKER',
      'HLSLEAKMARKER', 'OWNERIDLEAKMARKER',
    ]) {
      expect(`${marker}:${dto.includes(marker)}`).toBe(`${marker}:false`);
    }
    for (const field of [
      'rawTags', 'sha256', 'fingerprint', 'audioSource', 'hlsMasterKey',
      'manifestKey', 'ownerOxyUserId',
    ]) {
      expect(`${field}:${dto.includes(field)}`).toBe(`${field}:false`);
    }
  });

  /**
   * `ContributionAttestation` carries the uploader's IP and user agent. The
   * artist-facing contributions panel exposes WHO contributed, deliberately —
   * it must never expose from where.
   */
  it('never exposes an attestation\'s ip, user agent or raw tags', async () => {
    const artistId = await makeArtistWithSuggestions();
    const track = await TrackModel.findOne({ artistId }).lean();
    await ContributionAttestationModel.create({
      trackId: track?._id.toString(),
      uploaderOxyUserId: 'a-stranger',
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
      ip: 'IPSERVERONLYMARKER',
      userAgent: 'UASERVERONLYMARKER',
      rawTags: { json: JSON.stringify({ apID: 'APIDSERVERONLYMARKER' }), truncated: false, originalByteLength: 9 },
    });

    const res = makeRes();
    await getMyContributions(makeReq(OWNER), res as unknown as Response, failNext);

    const json = JSON.stringify(res._body);
    // The panel answered with the contribution — otherwise the absences are vacuous.
    expect(json).toContain('a-stranger');
    for (const marker of ['IPSERVERONLYMARKER', 'UASERVERONLYMARKER', 'APIDSERVERONLYMARKER']) {
      expect(`${marker}:${json.includes(marker)}`).toBe(`${marker}:false`);
    }
  });
});