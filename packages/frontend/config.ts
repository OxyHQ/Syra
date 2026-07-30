// Base URLs
// Base URLs (prod first → env → fallback)
// Local dev ports are assigned per app across the Oxy ecosystem so two apps can
// run side by side: Syra owns backend 4120 / Metro 8120. Production is unaffected
// (ECS injects PORT explicitly).
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.syra.fm/api'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4120/api');
export const SOCKET_URL =
  process.env.NODE_ENV === "production"
    ? "wss://api.syra.fm"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:4120");

export const API_URL_SOCKET =
  process.env.NODE_ENV === "production"
    ? "wss://api.syra.fm"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:4120");

export const API_URL_SOCKET_CHAT = process.env.API_URL_SOCKET_CHAT || 'http://localhost:4120';
export const API_OXY_CHAT = process.env.API_OXY_CHAT || 'http://localhost:4120';
export const OXY_BASE_URL = process.env.EXPO_PUBLIC_OXY_BASE_URL || 'https://api.oxy.so';

// Syra's registered Oxy OAuth client id (public — safe to commit).
// Required by @oxyhq/services >=10 for the cross-app device sign-in flow.
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ??
  'oxy_dk_3b5d68c224b7eaf690b2f682fb60399b31e5c7ab87c66181';
