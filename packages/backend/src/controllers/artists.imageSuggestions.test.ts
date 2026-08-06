import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import type { Response, NextFunction } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import type { ArtistImageSuggestionsResponse } from '@syra/shared-types';
import { connect, clear, disconnect } from '../test/mongo';
import { clearDb, connectDb, disconnectDb } from '../test/postgres';
import {
  installCatalogImageMirrorMockForTests,
  resetCatalogImageMirror,
} from '../test/catalogImageMirror';
import { ArtistModel } from '../models/CatalogEntity';
import { TrackModel } from '../models/Track';
import { ContributionAttestationModel } from '../models/ContributionAttestation';
import { UserUploadModel } from '../models/UserUpload';
import { toUploadTrackDto } from './uploads.controller';
import { formatTracksWithCoverArt, formatArtistWithImage } from '../utils/musicHelpers';
import { getEntityProfile } from './entityProfile.controller';
import {
  getMyImageSuggestions,
  acceptMyImageSuggestion,
  discardMyImageSuggestion,
  getArtistById,
  getMyContributions,
} from './artists.controller';

/**
 * Suggested profile photos are a guess about what a real person looks like.
 * They must be readable ONLY by the artist whose profile they sit on, and
 * publishable only once that artist has said yes.
 *
 * THREE mechanisms guard that, and only the third holds on the catalog read
 * path: `select: false` on the Mongoose path (inert under `aggregate()`, which
 * every container helper uses), the absent `artistSchema` field (inert against
 * `formatArtistWithImage`, which is untyped and spreads the whole document), and
 * the explicit `delete` in `stripExternalCatalogFields`. `GET /api/artists/:id`
 * really did return suggestions before that third one existed — verified against
 * the handler, which is why the fixture below gives the artist a playable track.
 */

/**
 * This suite reaches `mirrorCatalogImage` through the accept endpoint, and used
 * to get its double as a SIDE EFFECT of `connect()`. That install is gone — it
 * was the trap `test/catalogImageMirror.ts` was extracted to close — so the
 * double is requested here, explicitly, and Postgres is opened because the
 * double writes real `image_assets` rows for the seven FK columns that now
 * reference them.
 *
 * Removing the side effect is what surfaced this suite: a `grep` for
 * `mirrorCatalogImage` in test files found three podcast suites and missed this
 * one, which reaches it through a controller. The full run found it. That is the
 * cost of an implicit install being paid once, visibly, instead of indefinitely.
 */
beforeAll(async () => {
  await connect();
  await connectDb();
});
beforeEach(installCatalogImageMirrorMockForTests);
afterEach(async () => {
  resetCatalogImageMirror();
  await clear();
  await clearDb();
});
afterAll(async () => {
  await disconnect();
  await disconnectDb();
});

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
   * artist with no catalogue 404s — and every "the suggestion did not leak"
   * assertion below would then pass against an empty error body, proving nothing.
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

function body(res: CapturedRes): ArtistImageSuggestionsResponse {
  return res._body as ArtistImageSuggestionsResponse;
}

// ── Reading ───────────────────────────────────────────────────────────────────

describe('GET /api/artists/me/image-suggestions', () => {
  it('returns the pending suggestions with their licence intact', async () => {
    await makeArtistWithSuggestions();

    const res = makeRes();
    await getMyImageSuggestions(makeReq(OWNER), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    expect(body(res).suggestions).toHaveLength(2);

    const commons = body(res).suggestions.find((s) => s.image.url === COMMONS_URL);
    expect(commons?.image.origin).toBe('external');
    if (commons?.image.origin !== 'external') throw new Error('expected the external arm');
    // CC BY-SA is satisfied by naming the author and linking the file page.
    expect(commons.image.licence.attribution).toBe('Jane Photographer');
    expect(commons.image.licence.sourceUrl).toContain('commons.wikimedia.org/wiki/File:');
    expect(commons.proposedAt).toBe('2026-07-01T00:00:00.000Z');

    const embedded = body(res).suggestions.find((s) => s.image.url === EMBEDDED_URL);
    expect(embedded?.proposedByOxyUserId).toBe('a-stranger');
    expect(embedded?.sourceUploadId).toBe('6a6d000000000000000000aa');
  });

  it('returns an empty list, not a 404, when there is nothing to decide', async () => {
    await makeArtistWithSuggestions([]);

    const res = makeRes();
    await getMyImageSuggestions(makeReq(OWNER), res as unknown as Response, failNext);

    expect(res._status).toBe(200);
    expect(body(res).suggestions).toEqual([]);
  });

  it('404s a caller with no artist profile', async () => {
    await makeArtistWithSuggestions();

    const res = makeRes();
    await getMyImageSuggestions(makeReq('somebody-else'), res as unknown as Response, failNext);

    expect(res._status).toBe(404);
  });
});

describe('POST /api/artists/me/image-suggestions/accept', () => {
  it('adopts the photo, keeps its licence, and clears every suggestion', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await acceptMyImageSuggestion(
      makeReq(OWNER, { url: COMMONS_URL }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    const artist = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    expect(artist?.image).toBeTruthy();
    expect(artist?.imageSizes).toBeTruthy();
    // The attribution has to survive the mirror or the image may not be used.
    expect(artist?.imageLicence?.attribution).toBe('Jane Photographer');
    expect(artist?.imageLicence?.licence).toBe('CC-BY-SA-4.0');
    // The question has been answered — the alternatives are not still pending.
    expect(artist?.imageSuggestions ?? []).toEqual([]);
  });

  it('carries NO licence for a photo lifted from an uploaded file', async () => {
    const artistId = await makeArtistWithSuggestions();

    await acceptMyImageSuggestion(
      makeReq(OWNER, { url: EMBEDDED_URL }),
      makeRes() as unknown as Response,
      failNext,
    );

    const artist = await ArtistModel.findById(artistId).lean();
    expect(artist?.image).toBeTruthy();
    expect(artist?.imageLicence).toBeUndefined();
  });

  /**
   * A stale licence describing the PREVIOUS photo would credit the wrong author
   * for the one now on display — worse than no credit at all.
   */
  it('clears a previous licence when an unlicensed photo replaces it', async () => {
    const artistId = await makeArtistWithSuggestions();
    await acceptMyImageSuggestion(
      makeReq(OWNER, { url: COMMONS_URL }),
      makeRes() as unknown as Response,
      failNext,
    );
    expect((await ArtistModel.findById(artistId).lean())?.imageLicence?.attribution)
      .toBe('Jane Photographer');

    // A second suggestion arrives later and is accepted.
    await ArtistModel.updateOne(
      { _id: artistId },
      { $set: { imageSuggestions: [EMBEDDED_SUGGESTION] } },
    );
    await acceptMyImageSuggestion(
      makeReq(OWNER, { url: EMBEDDED_URL }),
      makeRes() as unknown as Response,
      failNext,
    );

    expect((await ArtistModel.findById(artistId).lean())?.imageLicence).toBeUndefined();
  });

  it('404s a url that is not among the suggestions', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await acceptMyImageSuggestion(
      makeReq(OWNER, { url: 'https://example.com/not-offered.jpg' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    const artist = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    expect(artist?.image).toBeUndefined();
    expect(artist?.imageSuggestions).toHaveLength(2);
  });

  it('rejects a body with no url', async () => {
    await makeArtistWithSuggestions();

    const res = makeRes();
    await acceptMyImageSuggestion(makeReq(OWNER, {}), res as unknown as Response, failNext);

    expect(res._status).toBe(400);
  });

  it('cannot accept a suggestion on somebody else\'s profile', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await acceptMyImageSuggestion(
      makeReq('an-impostor', { url: COMMONS_URL }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    expect((await ArtistModel.findById(artistId).lean())?.image).toBeUndefined();
  });
});

describe('POST /api/artists/me/image-suggestions/discard', () => {
  it('removes just that one and leaves the rest to decide', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await discardMyImageSuggestion(
      makeReq(OWNER, { url: COMMONS_URL }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(200);
    expect(body(res).suggestions.map((s) => s.image.url)).toEqual([EMBEDDED_URL]);

    const artist = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    expect(artist?.imageSuggestions).toHaveLength(1);
    // Refusing a photo must never adopt one.
    expect(artist?.image).toBeUndefined();
  });

  it('404s a url that is not among the suggestions', async () => {
    await makeArtistWithSuggestions();

    const res = makeRes();
    await discardMyImageSuggestion(
      makeReq(OWNER, { url: 'https://example.com/never-offered.jpg' }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
  });

  it('cannot discard from somebody else\'s profile', async () => {
    const artistId = await makeArtistWithSuggestions();

    const res = makeRes();
    await discardMyImageSuggestion(
      makeReq('an-impostor', { url: COMMONS_URL }),
      res as unknown as Response,
      failNext,
    );

    expect(res._status).toBe(404);
    const artist = await ArtistModel.findById(artistId).select('+imageSuggestions').lean();
    expect(artist?.imageSuggestions).toHaveLength(2);
  });
});
