import type { RequestHandler } from 'express';

/**
 * Permissive, non-credentialed CORS for HLS *media* endpoints — the master
 * playlist, variant playlists, and the AES-128 decryption key.
 *
 * Why this is separate from the global, credentialed CORS in `server.ts`:
 * the Google Cast Default Media Receiver is a Google-hosted page that fetches
 * the HLS manifest, variant playlists, and decryption key from `api.syra.fm`
 * with a foreign `Origin` (e.g. `https://www.gstatic.com`). The global CORS only
 * echoes `Access-Control-Allow-Origin` for allowlisted Syra origins, so those
 * cross-origin reads receive no ACAO header → the browser blocks them → Cast
 * connects but plays no audio.
 *
 * These media bytes are authorized by an in-URL `?t=` stream token, never by a
 * cookie or `Authorization` header, so there are no credentials to protect:
 * `Access-Control-Allow-Origin: *` is both required (for Cast) and safe here.
 * `*` is incompatible with `Access-Control-Allow-Credentials: true`, which the
 * global CORS sets for every response, so we strip that header.
 *
 * Apply ONLY to the tokenized media endpoints — never to the bearer-authed JSON
 * resolvers (`GET /stream/:trackId`, `GET /podcasts/episodes/:id/stream`), which
 * must keep the credentialed, origin-allowlisted CORS.
 */
export const streamMediaCors: RequestHandler = (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  );
  res.vary('Origin');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
};
