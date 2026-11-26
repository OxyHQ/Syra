# Frontend state architecture

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

- **TanStack Query** for server state: catalog reads, library, playlists, artist profile, preferences, recommendations, privacy.
- **Zod** at API boundaries: parse once in the service layer, return typed data, fail loudly through the existing error path.
- **Zustand** only for local-only state: player state, queue UI state, session-independent UI preferences, transient interaction state. Do NOT mirror liked tracks, playlists, or profile data in Zustand when TanStack Query already owns that remote state.
- Mutations must invalidate relevant TanStack Query keys immediately — like/unlike must update the button, library lists, album/track screens, and player state without reload.
- Queue/playback Zustand state may optimistically update but must persist through `queueService` and repair backend drift by replacing the queue, not hiding 400 errors with local-only state.
- **Account cache** (Services 15 holds no React Query cache, so Syra owns it): each app mounts its own `QueryClientProvider` above `OxyProvider` and an `AccountQueryScope` as `OxyProvider`'s first child. On every subject change (switch, sign-in, sign-out) every query is removed and reset synchronously, from the Services runtime's notification, before the new account renders; a late answer for the old account lands nowhere. The frontend also persists each account's queries under `syra_account_queries:<account>` (not `search`), drops them on a new build and deletes them on sign-out (`packages/frontend/lib/accountQueryCache.ts`; tests in `__tests__/security/account-cache-*`). Studio keeps its queries in memory only. Never key data to an account outside this cache, and never persist a React Query cache another way.
