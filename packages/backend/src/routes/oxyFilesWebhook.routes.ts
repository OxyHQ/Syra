import express, { Router, type Request, type Response } from 'express';
import { FileEventVerificationError, verifyFileEventSignature } from '@oxy.so/core/server';
import { applyFileEvent } from '../services/oxyFiles/fileEvents';
import { assertRawBody } from './crowdsourceWebhook.routes';
import { logger } from '../utils/logger';
import { describeErrorSafely } from '../utils/error';

/**
 * `POST /webhooks/oxy/files` — Oxy's file events (OxyHQ/oxy ADR 0043 D9).
 *
 * Mounted in `server.ts` BEFORE `express.json()`, like the LiveKit and
 * CrowdSource receivers and for the same reason: the signature covers
 * `"<t>.<raw body>"`, the exact bytes Oxy sent, and a JSON parser that ran first
 * would leave only a re-serialization to verify. `assertRawBody` refuses (500,
 * naming the misconfiguration) rather than verifying reconstructed bytes.
 *
 * Unconfigured — no `OXY_FILES_WEBHOOK_SECRET` — it answers 404, exactly as if
 * the route did not exist, except for the one request Oxy sends while the
 * endpoint is being REGISTERED: its verification challenge, which carries no
 * signature by design (the secret is created by that very registration). Echoing
 * it is all that is ever done with a challenge.
 *
 * 2xx means "applied, or already applied"; anything else is retried by Oxy with
 * backoff, so an error here is safe to return and a 500 is better than a lie.
 */

/** Oxy's file events are small JSON documents; this bounds what is buffered. */
const MAX_BODY_BYTES = 256 * 1024;

export function createOxyFilesWebhookRoutes(): Router {
  const router = Router();
  router.post(
    '/',
    assertRawBody,
    express.raw({ type: 'application/json', limit: MAX_BODY_BYTES }),
    async (req: Request, res: Response) => {
      const secret = process.env.OXY_FILES_WEBHOOK_SECRET?.trim() ?? '';
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body)) {
        res.status(400).json({ error: 'Expected a JSON body' });
        return;
      }

      let event: ReturnType<typeof verifyFileEventSignature>;
      try {
        event = verifyFileEventSignature(body, req.headers, secret);
      } catch (error) {
        if (error instanceof FileEventVerificationError) {
          if (secret === '') {
            res.status(404).end();
            return;
          }
          logger.warn('[OxyFiles] refused a file event', { reason: error.message });
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
        throw error;
      }

      if (event.type === 'webhook.challenge') {
        res.json({ challenge: event.challenge });
        return;
      }

      try {
        const applied = await applyFileEvent(event);
        res.status(applied.duplicate ? 200 : 204).end();
      } catch (error) {
        logger.error('[OxyFiles] could not apply a file event; Oxy will retry', {
          eventId: event.id,
          error: describeErrorSafely(error),
        });
        res.status(500).json({ error: 'Not applied' });
      }
    },
  );
  return router;
}
