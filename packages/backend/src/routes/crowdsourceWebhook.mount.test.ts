import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import express, { type Express } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { caseDecidedEventFixture, signWebhookDelivery } from '@oxyhq/crowdsource-testing';
import { count, eq } from 'drizzle-orm';
import { connectDb, clearDb, disconnectDb } from '../test/postgres';
import { getDb } from '../db/postgres';
import { moderationEvents, moderationOutbox } from '../db/schema/moderation';
import { resetCrowdSourceConfig } from '../moderation/config';
import { resetModerationIntegration } from '../moderation/integration';
import { logger } from '../utils/logger';
import { assertRawBody, createCrowdSourceWebhookRoutes } from './crowdsourceWebhook.routes';

/**
 * The mount order, which is part of the correctness and which no type can hold.
 *
 * The receiver's HMAC covers the exact bytes that arrived and it reads the request
 * stream itself. Below a JSON parser it would be verifying a signature over a
 * re-serialization, so it refuses outright — and this file is what makes that
 * refusal a regression test rather than a comment.
 */

const SECRET = 'whsec_test_secret_value_for_syra';

interface Harness {
  url: string;
  close: () => Promise<void>;
}

async function listen(app: Express): Promise<Harness> {
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // `fetch` leaves a keep-alive socket open, and `close()` waits for every
        // connection to end — so without `closeAllConnections()` the teardown
        // hook hangs until the runner kills it, and the failure reads as the
        // request rather than the harness. The close error is ignored on purpose:
        // "Server is not running" is the ordinary outcome when a test already
        // tore its own server down, and it is not a result worth failing on.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Production: the receiver sits ABOVE the parser, as in `server.ts`. */
function correctlyMountedApp(): Express {
  const app = express();
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  app.use(express.json());
  return app;
}

/** The regression: a parser ran first. */
function wronglyMountedApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', createCrowdSourceWebhookRoutes());
  return app;
}

let harness: Harness | undefined;

/**
 * A real database, because the correctly-mounted path runs all the way through
 * the SDK middleware into the Postgres-backed dedupe store — the claim is an
 * INSERT whose primary key is the event id, so there is nothing to fake that
 * would still prove a redelivery cannot be claimed twice.
 */
beforeAll(connectDb);
afterAll(disconnectDb);

/** How many rows a table holds, as `countDocuments` answered under Mongoose. */
async function rowsIn(table: typeof moderationEvents | typeof moderationOutbox): Promise<number> {
  const [row] = await getDb().select({ total: count() }).from(table);
  return row?.total ?? 0;
}

beforeEach(() => {
  process.env.CROWDSOURCE_ENABLED = 'true';
  process.env.CROWDSOURCE_SERVICE_KEY = 'app_1:cred_1:secret';
  process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;
  resetCrowdSourceConfig();
  // The integration caches the config it was built from, and the webhook router
  // is bound on first request — so resetting one without the other leaves the
  // previous test's secret live behind a route that reads the new one.
  resetModerationIntegration();
});

afterEach(async () => {
  await harness?.close();
  await clearDb();
  harness = undefined;
  delete process.env.CROWDSOURCE_ENABLED;
  delete process.env.CROWDSOURCE_SERVICE_KEY;
  delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
  resetCrowdSourceConfig();
  resetModerationIntegration();
});

/**
 * The simulator returns the exact bytes it signed. Re-serialising the event here
 * would produce a different body than the signature covers and turn every one of
 * these into an accidental tamper test.
 */
function signedDelivery() {
  return signWebhookDelivery({ secret: SECRET, event: caseDecidedEventFixture() });
}

describe('CrowdSource webhook mount order', () => {
  /**
   * The acceptance sibling — asserted on SIDE EFFECTS, not on a status code.
   *
   * A refusal test alone only proves the request was malformed somehow. This is
   * its pair, and it has to prove the same delivery is genuinely handled, which a
   * status code cannot do: this receiver answers `200 { handled: false }` to an
   * envelope the schema rejects, so an endpoint that ran no handler at all would
   * satisfy every status assertion. The decision reaching the database is the
   * only thing that distinguishes "accepted" from "acknowledged and dropped".
   */
  it('accepts a signed delivery and records the decision', async () => {
    harness = await listen(correctlyMountedApp());
    const delivery = signedDelivery();
    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    expect(await response.json()).toMatchObject({ handled: true });

    // §10.8: the event is recorded and the work is queued, in one transaction.
    const queued = await getDb()
      .select({ total: count() })
      .from(moderationEvents)
      .where(eq(moderationEvents.state, 'queued'));
    expect(queued[0]?.total).toBe(1);
    const applies = await getDb()
      .select({ total: count() })
      .from(moderationOutbox)
      .where(eq(moderationOutbox.kind, 'decision.apply'));
    expect(applies[0]?.total).toBe(1);
  });

  /**
   * That the HMAC is actually compared, which nothing else here proves.
   *
   * Every other test in this file would pass with the signature check deleted —
   * they turn on the mount, not on the cryptography. A tampered body against a
   * valid signature is refused, and the assertion names the rejection REASON
   * rather than the status: a 401 for a missing header would satisfy a
   * status-only test while proving the signature was never compared at all.
   */
  it('refuses a tampered body, for the signature reason specifically', async () => {
    /**
     * Observed through the route's own `onRejected`, which logs the reason —
     * rather than by adding a test-only parameter to the factory. The production
     * path is the thing under test; a seam built for the test would be a
     * different path that happens to agree.
     */
    const rejections: string[] = [];
    const originalWarn = logger.warn;
    logger.warn = ((message: string, meta?: unknown) => {
      const rejection =
        meta && typeof meta === 'object' && 'rejection' in meta
          ? (meta as { rejection: unknown }).rejection
          : undefined;
      if (typeof rejection === 'string') rejections.push(rejection);
      return originalWarn(message, meta);
    }) as typeof logger.warn;

    harness = await listen(correctlyMountedApp());

    const event = caseDecidedEventFixture();
    const delivery = signWebhookDelivery({
      secret: SECRET,
      event,
      // Signed over the real event, delivered as something else.
      tamperedBody: JSON.stringify({ ...event, data: { caseId: 'case_forged' } }),
    });

    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    logger.warn = originalWarn;

    expect(response.status).toBeGreaterThanOrEqual(400);
    // `signature_mismatch` specifically, taken from the SDK's own emitted token
    // rather than guessed: it is what proves the signature was COMPARED. A
    // missing-header rejection would also be a 4xx and would also be "refused",
    // while proving the comparison never happened.
    expect(rejections).toEqual(['signature_mismatch']);
    // Nothing recorded: a forged delivery must not reach the database at all.
    expect(await rowsIn(moderationEvents)).toBe(0);
    expect(await rowsIn(moderationOutbox)).toBe(0);
  });

  /**
   * Mutation evidence in permanent form. Move the mount below `express.json()`
   * and this fails — with a refusal rather than a signature mismatch, so the
   * diagnosis is in the failure.
   */
  it('REFUSES to verify anything when mounted below the parser', async () => {
    harness = await listen(wronglyMountedApp());
    const delivery = signedDelivery();
    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });

    expect(response.status).toBe(500);
    const payload: unknown = await response.json();
    // A refusal reason and nothing about the delivery it refused.
    expect(JSON.stringify(payload)).toContain('misconfigured');
    expect(JSON.stringify(payload)).not.toContain('signature');
  });

  it('sees an unparsed body when mounted above the parser', async () => {
    let observedBodyType = 'never ran';
    const app = express();
    const router = express.Router();
    router.post('/crowdsource', (req, res) => {
      observedBodyType = typeof req.body;
      res.status(204).end();
    });
    app.use('/webhooks', router);
    app.use(express.json());
    harness = await listen(app);

    await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(observedBodyType).toBe('undefined');
  });
});

describe('assertRawBody in isolation', () => {
  function run(body: unknown): { statusCode: number | undefined; passedThrough: boolean } {
    let statusCode: number | undefined;
    let passedThrough = false;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };
    assertRawBody(
      { body } as express.Request,
      res as unknown as express.Response,
      () => {
        passedThrough = true;
      },
    );
    return { statusCode, passedThrough };
  }

  it('passes through only when the body is untouched', () => {
    expect(run(undefined)).toEqual({ statusCode: undefined, passedThrough: true });
  });

  /**
   * A Buffer means `express.raw()` ran, which is not this route's mount either —
   * it reads the stream itself, so accepting a Buffer would make the guard depend
   * on somebody else's parser staying configured as it is today.
   */
  it('refuses a parsed object, an empty object and a Buffer alike', () => {
    for (const body of [{ a: 1 }, {}, Buffer.from('{}'), '', 'text']) {
      const outcome = run(body);
      expect(outcome.passedThrough).toBe(false);
      expect(outcome.statusCode).toBe(500);
    }
  });
});

describe('CrowdSource webhook route without a secret', () => {
  /**
   * Not mounted, rather than mounted and permissive. A route that answers anything
   * at all without a secret is a route that will one day be reasoned about as if it
   * verified something.
   */
  it('404s, indistinguishably from not having the feature', async () => {
    delete process.env.CROWDSOURCE_ENABLED;
    delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
    resetCrowdSourceConfig();
    resetModerationIntegration();

    const app = express();
    app.use('/webhooks', createCrowdSourceWebhookRoutes());
    harness = await listen(app);
    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
  });
});
