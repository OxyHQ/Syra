# Frontend state architecture

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

- **TanStack Query** for server state: catalog reads, library, playlists, artist profile, preferences, recommendations, privacy.
- **Zod** at API boundaries: parse once in the service layer, return typed data, fail loudly through the existing error path.
- **Zustand** only for local-only state: player state, queue UI state, session-independent UI preferences, transient interaction state. Do NOT mirror liked tracks, playlists, or profile data in Zustand when TanStack Query already owns that remote state.
- Mutations must invalidate relevant TanStack Query keys immediately — like/unlike must update the button, library lists, album/track screens, and player state without reload.
- Queue/playback Zustand state may optimistically update but must persist through `queueService` and repair backend drift by replacing the queue, not hiding 400 errors with local-only state.
