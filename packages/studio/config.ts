// Base URLs (prod first → env → fallback). Syra Studio talks to the same
// backend as the main Syra app (api.syra.fm). The API mounts every route under
// `/api`, so the base URL includes that prefix and service calls are relative to it.
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.syra.fm/api'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api');

export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');

// Public origin of the Syra API, used to derive a copyable RSS feed URL when the
// backend has not persisted an absolute `feedUrl` (e.g. local dev without
// STREAM_KEY_BASE_URL set). The generated feed lives at
// `${RSS_PUBLIC_BASE}/api/podcasts/<id>/rss`.
export const RSS_PUBLIC_BASE =
  process.env.EXPO_PUBLIC_RSS_PUBLIC_BASE ??
  (process.env.NODE_ENV === 'production' ? 'https://api.syra.fm' : 'http://localhost:3000');

// Syra's registered Oxy OAuth client id (public — safe to commit). Shared with
// the main Syra app so a single Oxy session signs the user into both surfaces.
// Required by @oxyhq/services >=10 for the cross-app device sign-in flow.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_3b5d68c224b7eaf690b2f682fb60399b31e5c7ab87c66181';
