import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import express, { type Express } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { caseDecidedEventFixture, signWebhookDelivery } from '@oxyhq/crowdsource-testing';
import { connect, clear, disconnect } from '../test/mongo';
import { resetCrowdSourceConfig } from '../moderation/config';
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
 * the SDK middleware into the Mongo-backed dedupe store. Without a connection
 * mongoose buffers the insert for ten seconds and the teardown hook times out —
 * which reads as a transport failure rather than a missing connection.
 */
beforeAll(connect);
afterAll(disconnect);

beforeEach(() => {
  process.env.CROWDSOURCE_ENABLED = 'true';
  process.env.CROWDSOURCE_SERVICE_KEY = 'app_1:cred_1:secret';
  process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;
  resetCrowdSourceConfig();
});

afterEach(async () => {
  await harness?.close();
  await clear();
  harness = undefined;
  delete process.env.CROWDSOURCE_ENABLED;
  delete process.env.CROWDSOURCE_SERVICE_KEY;
  delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
  resetCrowdSourceConfig();
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
  it('reaches the verifier when mounted above the parser', async () => {
    harness = await listen(correctlyMountedApp());
    const delivery = signedDelivery();
    const response = await fetch(`${harness.url}/webhooks/crowdsource`, {
      method: 'POST',
      headers: delivery.headers,
      body: delivery.body,
    });
    // No 500: the guard passed and the SDK middleware took the request.
    expect(response.status).not.toBe(500);
    expect(response.status).not.toBe(404);
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
