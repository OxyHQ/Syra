import type { OxyAuthRequest, RequesterProof } from '@oxy.so/core/server';

/** Uses the session verified by shared middleware; never reads a raw user header. */
export function personalFilesRequester(
  req: Pick<OxyAuthRequest, 'user' | 'accessToken'>,
): RequesterProof {
  if (!req.user?.id || !req.accessToken) {
    throw new Error('Personal Files operation requires the original signed-in requester');
  }
  return { requesterToken: req.accessToken, accountId: req.user.id };
}
