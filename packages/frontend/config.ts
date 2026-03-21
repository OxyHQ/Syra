// Base URLs
// Base URLs (prod first → env → fallback)
export const API_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://api.syra.oxy.so/api'
    : (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000/api');
export const SOCKET_URL =
  process.env.NODE_ENV === "production"
    ? "wss://api.syra.oxy.so"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:3000");

export const API_URL_SOCKET =
  process.env.NODE_ENV === "production"
    ? "wss://api.syra.oxy.so"
    : (process.env.API_URL_SOCKET ?? "ws://localhost:3000");

export const API_URL_SOCKET_CHAT = process.env.API_URL_SOCKET_CHAT || 'http://localhost:4000';
export const API_OXY_CHAT = process.env.API_OXY_CHAT || 'http://localhost:4000';
export const OXY_BASE_URL =
  process.env.EXPO_PUBLIC_OXY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.oxy.so' : 'http://localhost:3001');
