/**
 * `POST /api/audio-uploads` — step 1 of a direct audio upload: a presigned PUT
 * the client sends its file to, straight to storage. The routes that complete one
 * are the ones that always took audio; `services/uploads/directAudioUpload.ts`
 * is the whole protocol and why it exists.
 *
 * Signed for the CALLER: the object lands under a key that names their account,
 * and only a completing request authenticated as that account can find it.
 */

import type { Response } from 'express';
import type { OxyAuthRequest as AuthRequest } from '@oxy.so/core/server';
import { getRequiredOxyUserId } from '@oxy.so/core/server';
import { createAudioUploadRequestSchema } from '@syra/shared-types';
import { createAudioUploadTarget } from '../services/uploads/directAudioUpload';

export async function createAudioUpload(req: AuthRequest, res: Response): Promise<void> {
  const userId = getRequiredOxyUserId(req);

  const parsed = createAudioUploadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid upload request', details: parsed.error.issues });
    return;
  }

  const result = await createAudioUploadTarget({
    purpose: parsed.data.purpose,
    principal: { kind: 'account', oxyUserId: userId },
    mimeType: parsed.data.mimeType,
    sizeBytes: parsed.data.sizeBytes,
  });
  if (!result.ok) {
    res.status(result.refusal.status).json(result.refusal.body);
    return;
  }

  res.status(201).json({ data: result.target });
}
