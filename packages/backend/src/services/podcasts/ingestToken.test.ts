/**
 * The ingest ticket's SIGNATURE layer, on its own.
 *
 * Split from the endpoint suite deliberately. This file asks only "is this token
 * authentic and well-formed"; `routes/podcastIngest.test.ts` asks "may this
 * authentic token do this thing to this episode right now", which is a different
 * question with different answers. A single suite mixing them would let a
 * passing case be explained by either layer.
 *
 * Every case here is a REFUSAL plus its positive control — the same token shape
 * that IS accepted — because `verifyIngestTicket` returns `null` for every
 * failure and a test that only checked for `null` would pass against a function
 * that returned `null` for everything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import jwt from 'jsonwebtoken';
import {
  INGEST_TICKET_PURPOSE,
  mintIngestTicket,
  verifyIngestTicket,
} from './ingestToken';

const SECRET = 'test-secret-ingest-token-unit';
const OTHER_SECRET = 'a-different-secret-entirely';

const CLAIMS = {
  episodeId: 'episode-1',
  podcastId: 'show-1',
  ownerOxyUserId: 'oxy-owner-1',
};

let ingestWas: string | undefined;
let streamWas: string | undefined;

beforeEach(() => {
  ingestWas = process.env.INGEST_TOKEN_SECRET;
  streamWas = process.env.STREAM_TOKEN_SECRET;
  process.env.INGEST_TOKEN_SECRET = SECRET;
});

afterEach(() => {
  // `process.env` is process-global exactly as a module mock is, so every case
  // here restores what it found rather than leaving a secret set for whatever
  // file `bun test` runs next.
  if (ingestWas === undefined) delete process.env.INGEST_TOKEN_SECRET;
  else process.env.INGEST_TOKEN_SECRET = ingestWas;
  if (streamWas === undefined) delete process.env.STREAM_TOKEN_SECRET;
  else process.env.STREAM_TOKEN_SECRET = streamWas;
});

describe('mintIngestTicket', () => {
  it('round-trips every claim, and mints a distinct jti each time', () => {
    const first = mintIngestTicket(CLAIMS);
    const second = mintIngestTicket(CLAIMS);

    const verified = verifyIngestTicket(first.token);
    expect(verified).toEqual({
      jti: first.claims.jti,
      episodeId: 'episode-1',
      podcastId: 'show-1',
      ownerOxyUserId: 'oxy-owner-1',
      purpose: INGEST_TICKET_PURPOSE,
    });

    // Two tickets for the SAME episode must be two capabilities, not one. A
    // shared `jti` would make the second redemption a replay of the first.
    expect(`distinct jti: ${first.claims.jti !== second.claims.jti}`).toBe('distinct jti: true');
  });

  it('reports an expiry the caller can store, matching the TTL it was given', () => {
    const before = Date.now();
    const { expiresAt } = mintIngestTicket(CLAIMS, 60);

    // The row's deadline is what is enforced, so the value handed back has to be
    // the real one rather than approximately right.
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt.getTime()).toBeLessThan(before + 62_000);
  });

  it('refuses to mint with no secret configured, loudly', () => {
    delete process.env.INGEST_TOKEN_SECRET;
    // THROWS at mint time, where a person is waiting for the answer — as opposed
    // to verify, which returns null. A silent unsigned ticket would be
    // discovered 20 minutes later as an unexplained rejection.
    expect(() => mintIngestTicket(CLAIMS)).toThrow('INGEST_TOKEN_SECRET not set');
  });
});

describe('verifyIngestTicket refuses', () => {
  /** The positive control every case below is measured against. */
  function accepted(): string {
    const { token } = mintIngestTicket(CLAIMS);
    expect(`control accepted: ${verifyIngestTicket(token) !== null}`).toBe(
      'control accepted: true'
    );
    return token;
  }

  it('an EXPIRED ticket', () => {
    accepted();

    // A negative TTL is already past its `exp` — no waiting, and no clock
    // manipulation that could pass for the wrong reason.
    const { token } = mintIngestTicket(CLAIMS, -1);
    expect(verifyIngestTicket(token)).toBeNull();
  });

  it('a ticket signed with a DIFFERENT secret', () => {
    accepted();

    const forged = jwt.sign({ ...CLAIMS, jti: 'x', purpose: INGEST_TICKET_PURPOSE }, OTHER_SECRET, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
    expect(verifyIngestTicket(forged)).toBeNull();
  });

  it('a ticket signed with STREAM_TOKEN_SECRET — a read capability is not a write one', () => {
    /**
     * The separation the two secrets exist for, as a test rather than a comment.
     *
     * A stream token is minted for every player that asks and is printed inside
     * manifest URLs. If the two capabilities shared a secret, every playback URL
     * would carry the material for forging one of these — so this asserts that
     * a token signed with the playback secret is refused even when its claims
     * are perfect.
     */
    accepted();

    process.env.STREAM_TOKEN_SECRET = OTHER_SECRET;
    const asStreamToken = jwt.sign(
      { ...CLAIMS, jti: 'x', purpose: INGEST_TICKET_PURPOSE },
      OTHER_SECRET,
      { algorithm: 'HS256', expiresIn: 3600 }
    );
    expect(verifyIngestTicket(asStreamToken)).toBeNull();
  });

  it('a ticket with the WRONG purpose, signed correctly', () => {
    /**
     * Correct secret, correct shape, wrong `purpose`. This is what stops a
     * second capability type minted under this secret later from being
     * redeemable here by nobody remembering to compare.
     */
    accepted();

    const wrongPurpose = jwt.sign({ ...CLAIMS, jti: 'x', purpose: 'episode-delete' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
    expect(verifyIngestTicket(wrongPurpose)).toBeNull();
  });

  it('a ticket missing any single required claim', () => {
    accepted();

    const complete = { jti: 'x', ...CLAIMS, purpose: INGEST_TICKET_PURPOSE };
    for (const omitted of ['jti', 'episodeId', 'podcastId', 'ownerOxyUserId'] as const) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[omitted];
      const token = jwt.sign(partial, SECRET, { algorithm: 'HS256', expiresIn: 3600 });
      expect(`without ${omitted}: ${verifyIngestTicket(token)}`).toBe(`without ${omitted}: null`);
    }
  });

  it('a claim that is present but EMPTY', () => {
    // `''` is a string and would pass a `typeof` test. An empty `episodeId`
    // compared against a real one refuses anyway, but an empty `jti` would be
    // claimed against a row that cannot exist — refuse it here, at the layer
    // that can see it.
    accepted();

    const token = jwt.sign(
      { jti: '', ...CLAIMS, purpose: INGEST_TICKET_PURPOSE },
      SECRET,
      { algorithm: 'HS256', expiresIn: 3600 }
    );
    expect(verifyIngestTicket(token)).toBeNull();
  });

  it('an unsigned token — alg: none', () => {
    accepted();

    const unsigned = jwt.sign({ jti: 'x', ...CLAIMS, purpose: INGEST_TICKET_PURPOSE }, '', {
      algorithm: 'none',
    });
    expect(verifyIngestTicket(unsigned)).toBeNull();
  });

  it('outright garbage, and an empty string', () => {
    accepted();
    expect(verifyIngestTicket('not-a-jwt')).toBeNull();
    expect(verifyIngestTicket('')).toBeNull();
  });

  it('a valid ticket when no secret is configured — it fails CLOSED', () => {
    const token = accepted();

    delete process.env.INGEST_TOKEN_SECRET;
    // A misconfigured deploy refuses every ticket rather than admitting them
    // unverified. The same token verified a line ago, so this is the secret's
    // absence and nothing else.
    expect(verifyIngestTicket(token)).toBeNull();
  });
});
