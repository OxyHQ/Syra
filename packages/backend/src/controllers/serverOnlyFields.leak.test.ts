import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { normalizeNameKey, type ArtistImageSuggestion } from '@syra/shared-types';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { catalogEntities, tracks } from '../db/schema/catalog';
import { loadImageVariants } from '../db/catalog/hydrate';
import { toArtistDto, toTrackDto } from '../db/catalog/serialize';
import { contributionAttestations, userUploadHlsRenditions, userUploads } from '../db/schema/creators';
import { UPLOAD_COLUMNS } from '../db/creators/uploads';
import { toUploadTrackDto, uploadImageIds } from '../db/creators/serialize';
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

/**
 * The catalogue, the locker (`user_uploads`) and the attestation are all
 * Postgres since Task 13 — and this suite covers all three serializers at once,
 * which is exactly why it lives at the controller level.
 */
/**
 * POSTGRES ONLY.
 *
 * This block used to say the opposite, and the reason it was wrong is worth
 * keeping: nothing here reads a Mongoose model, but `entityProfile.controller`
 * still GATED every handler on `isDatabaseConnected()` — Mongoose readiness —
 * so without a Mongo connection every request answered 503 and these suites had
 * to open one. The guard was the whole dependency.
 *
 * Task 15 switched that gate to `isPostgresConnected()`, and the Mongo hooks
 * went with it. `db/__tests__/connectivityGates.test.ts` used to keep this true
 * by walking this controller's whole import graph and failing if anything it
 * reached opened a model; it was retired in 8cd87a8 together with its subject.
 * Nothing polices it now because nothing can violate it — `mongoose` is not a
 * dependency and `src/models/` does not exist, so reintroducing a model is a
 * package install and a new directory, not a silent import.
 */
beforeAll(async () => {
  await connectDb();
});
afterEach(async () => {
  await clearDb();
});
afterAll(async () => {
  await disconnectDb();
});

async function readArtist(id: string) {
  const [row] = await getDb()
    .select()
    .from(catalogEntities)
    .where(eq(catalogEntities.id, id))
    .limit(1);
  return row;
}

async function readTrackOfArtist(artistId: string) {
  const [row] = await getDb()
    .select()
    .from(tracks)
    .where(eq(tracks.artistId, artistId))
    .limit(1);
  return row;
}

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

const COMMONS_SUGGESTION: ArtistImageSuggestion = {
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
  proposedAt: '2026-07-01T00:00:00.000Z',
};

const EMBEDDED_SUGGESTION: ArtistImageSuggestion = {
  image: { origin: 'upload' as const, url: EMBEDDED_URL, width: 500, height: 500 },
  proposedAt: '2026-07-02T00:00:00.000Z',
  proposedByOxyUserId: 'a-stranger',
  sourceUploadId: '6a6d000000000000000000aa',
};

async function makeArtistWithSuggestions(
  suggestions: ArtistImageSuggestion[] = [COMMONS_SUGGESTION, EMBEDDED_SUGGESTION],
): Promise<string> {
  const name = `Suggested ${uuidv7()}`;
  const [artist] = await getDb()
    .insert(catalogEntities)
    .values({
      type: 'artist',
      name,
      nameKey: normalizeNameKey(name),
      source: 'upload',
      origin: 'contributed',
      ownerOxyUserId: OWNER,
      claimedByOxyUserId: OWNER,
      claimable: false,
      imageSuggestions: suggestions,
    })
    .returning({ id: catalogEntities.id, name: catalogEntities.name });
  if (!artist) throw new Error('makeArtistWithSuggestions: insert returned no row');
  /**
   * A PLAYABLE track, and it is load-bearing rather than scenery: the public
   * artist endpoint resolves through `findOneArtistWithPlayableTracks`, so an
   * artist with no catalogue 404s — and every "the secret did not leak"
   * assertion would then pass against an empty error body, proving nothing.
   */
  await getDb().insert(tracks).values({
    title: 'Something Playable',
    artistId: artist.id,
    artistName: artist.name,
    duration: 180,
    source: 'upload',
    status: 'ready',
    isAvailable: true,
  });
  return artist.id;
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
    await getDb()
      .update(tracks)
      .set({ sha256: 'SHA256SERVERONLYMARKER' })
      .where(eq(tracks.artistId, artistId));

    // Vacuity floor: the values must really be stored, or "absent" proves nothing.
    const stored = await readTrackOfArtist(artistId);
    expect(stored?.sha256).toBe('SHA256SERVERONLYMARKER');
    const storedArtist = await readArtist(artistId);
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
   * The route test above can pass for the wrong reason, so this tests the
   * SERIALIZER directly — and what makes it the right test changed with the
   * port, which is worth stating rather than leaving the old rationale in place.
   *
   * Under Mongo the danger was that `select: false` is a query projection and
   * `aggregate()` ignores it, so a document arrived with the field present and
   * the ONLY guard was the `delete` in `stripExternalCatalogFields`. This test
   * reproduced that: hand the formatter a document shaped the way an aggregation
   * returns one, assert the strip fires.
   *
   * On Postgres the mechanism is an ALLOWLIST, not a denylist: `toTrackDto` and
   * `toArtistDto` name every field they emit, and `publicColumns()` removes
   * `sha256`, `images` and `image_suggestions` from the row TYPE so a serializer
   * naming one does not compile. That is strictly stronger — but only for a
   * caller that used `publicColumns()`. A caller that selects the whole row is
   * exactly the modern equivalent of the aggregation, so that is what this seeds:
   * a full `select()` carrying the protected columns, handed to the real DTO.
   */
  it('drops server-only columns from a row selected WITHOUT publicColumns()', async () => {
    const artistId = await makeArtistWithSuggestions();
    await getDb()
      .update(tracks)
      .set({ sha256: 'SHA256FUNNELMARKER' })
      .where(eq(tracks.artistId, artistId));

    // A bare `select()` — every column, including the protected ones.
    const artistRow = await readArtist(artistId);
    const trackRow = await readTrackOfArtist(artistId);

    // Vacuity floor, before the assertions: both rows must exist AND must really
    // carry the secrets, or every `not.toContain` below proves nothing.
    if (!artistRow || !trackRow) {
      throw new Error('fixture produced no artist/track — the leak assertions would be vacuous');
    }
    expect(trackRow.sha256).toBe('SHA256FUNNELMARKER');
    expect(artistRow.imageSuggestions).toHaveLength(2);

    const lookup = await loadImageVariants([]);
    const formattedTrack = toTrackDto(trackRow, lookup, { hlsRenditionCount: 0 });
    expect(JSON.stringify(formattedTrack)).not.toContain('SHA256FUNNELMARKER');
    expect(JSON.stringify(formattedTrack)).not.toContain('sha256');

    const formattedArtist = toArtistDto(artistRow, lookup);
    expect(JSON.stringify(formattedArtist)).not.toContain('imageSuggestions');
    expect(JSON.stringify(formattedArtist)).not.toContain('upload.wikimedia.org');

    // Vacuity floor: the serializers really did return the entities.
    expect(formattedTrack.id).toBe(trackRow.id);
    expect(formattedArtist.id).toBe(artistId);
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
    const [inserted] = await getDb()
      .insert(userUploads)
      .values({
        ownerOxyUserId: 'OWNERIDLEAKMARKER',
        title: 'Locker File',
        duration: 200,
        sizeBytes: 1,
        sha256: 'SHA256LEAKMARKER',
        status: 'ready',
        audioSourceKey: 'uploads/OWNERIDLEAKMARKER/AUDIOKEYLEAKMARKER.mp3',
        audioSourceFormat: 'mp3',
        hlsMasterKey: 'hls/uploads/OWNERIDLEAKMARKER/HLSLEAKMARKER/master.m3u8',
        fingerprint: [1, 2, 3],
        fingerprintDurationSec: 200,
        rawTagsJson: JSON.stringify({ apID: 'APIDLEAKMARKER' }),
        rawTagsTruncated: false,
        rawTagsOriginalByteLength: 42,
      })
      .returning({ id: userUploads.id });
    await getDb().insert(userUploadHlsRenditions).values({
      userUploadId: inserted.id,
      position: 0,
      manifestKey: 'hls/uploads/OWNERIDLEAKMARKER/HLSLEAKMARKER/160/index.m3u8',
      bitrateKbps: 160,
      encrypted: true,
    });

    // Vacuity floor: every secret really is stored on the row. Read with an
    // EXPLICIT projection naming the protected columns, because the sanctioned
    // read (`UPLOAD_COLUMNS`) cannot see them — which is itself the point.
    const [stored] = await getDb()
      .select({
        rawTagsJson: userUploads.rawTagsJson,
        sha256: userUploads.sha256,
        audioSourceKey: userUploads.audioSourceKey,
      })
      .from(userUploads)
      .where(eq(userUploads.id, inserted.id));
    expect(stored?.rawTagsJson).toContain('APIDLEAKMARKER');
    expect(stored?.sha256).toBe('SHA256LEAKMARKER');
    expect(stored?.audioSourceKey).toContain('AUDIOKEYLEAKMARKER');

    // The row as the DTO actually receives it — through `UPLOAD_COLUMNS`, the
    // same projection every production caller uses.
    const [row] = await getDb()
      .select(UPLOAD_COLUMNS)
      .from(userUploads)
      .where(eq(userUploads.id, inserted.id));
    const dto = JSON.stringify(toUploadTrackDto(row, await loadImageVariants(uploadImageIds(row))));

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
    const track = await readTrackOfArtist(artistId);
    if (!track) throw new Error('readTrackOfArtist returned no track');
    await getDb().insert(contributionAttestations).values({
      trackId: track.id,
      uploaderOxyUserId: 'a-stranger',
      statement: 'I may distribute this recording',
      acceptedAt: new Date(),
      ip: 'IPSERVERONLYMARKER',
      userAgent: 'UASERVERONLYMARKER',
      rawTagsJson: JSON.stringify({ apID: 'APIDSERVERONLYMARKER' }),
      rawTagsTruncated: false,
      rawTagsOriginalByteLength: 9,
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