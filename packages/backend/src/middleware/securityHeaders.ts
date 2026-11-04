import { createOxySecurityHeaders } from '@oxy.so/core/server';

/**
 * Helmet's hardening (HSTS, `nosniff`, frameguard, referrer policy, …) plus the
 * Oxy CSP baseline — which governs nothing here, since a JSON API serves no
 * document, and costs nothing.
 *
 * Cross-origin resource policy is opened on purpose: cover art, avatars and HLS
 * segments are loaded by `<img>` and media elements on syra.fm and the other app
 * origins (and by the Cast receiver), which Helmet's default `same-origin` would
 * block.
 */
export const securityHeaders = createOxySecurityHeaders({
  helmet: { crossOriginResourcePolicy: { policy: 'cross-origin' } },
});
