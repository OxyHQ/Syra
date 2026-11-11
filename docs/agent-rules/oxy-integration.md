# Oxy integration and domains

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

- Own service calls use the shared workload provider, without internal scopes or client keys; personal Files writes need original requester proof. Status and cutover: `docs/architecture/first-party-platform.md`.

- Reviewers hold `compliance.review` via their role in the owning Oxy org (oxy ADR 0056, oxy registry): no grants, no env lists. Keep `config/applicationPermissions.ts` equal to the registry.
- Gate private API calls (library, playlists, artist profile, privacy, preferences, recommendations) with `useAuth().canUsePrivateApi` / `isPrivateApiPending` — not app-local token helpers.
- `utils/api.ts` owns the linked frontend client; cross-product callers use `syraForOxySession` (`docs/first-party-sdk.md`). No local token/refresh plumbing.
