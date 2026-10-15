import cors from 'cors';
import { env } from '../config/env';

export const ALLOWED_ORIGINS: string[] = [
  env.FRONTEND_URL,
  'https://syra.fm',
  'https://mention.earth',
  'https://www.mention.earth',
  // Alia (alia.onl) generates podcast episodes into Syra-hosted shows and plays
  // them back from `/api/podcasts/episodes/:id/audio` with the listener's own
  // bearer token. That is a browser fetch carrying `Authorization`, so it is
  // preflighted and needs an exact origin entry here — `Authorization` is
  // already in ALLOWED_HEADERS. Native Alia is unaffected either way: React
  // Native sends no `Origin` header and is not subject to CORS at all.
  //
  // Only the app origin. `console.alia.onl` and the canvas do not play audio,
  // and a first-party app is listed here rather than pushed through
  // ALLOWED_ORIGINS because that variable is absent from the deploy workflow's
  // secret allow-list, where an unnamed secret arrives as an empty string with
  // no error at all.
  'https://alia.onl',
  'http://localhost:8120',
  'http://localhost:8121',
  ...env.ALLOWED_ORIGINS,
];

// One source of truth for the CORS allow-list so the HTTP and Socket.IO
// configs can never drift apart. `X-Syra-Device-Id` lets a guest identify its
// device for radio/session reads (not a security boundary — see radio.controller).
export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Requested-With',
  'Accept',
  'Accept-Version',
  'Content-Length',
  'Content-MD5',
  'Date',
  'X-Api-Version',
  'X-Syra-Device-Id',
  'X-Oxy-Edge-Region',
  'X-Oxy-Activity-Id',
];

export const apiCors = cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ALLOWED_HEADERS,
});
