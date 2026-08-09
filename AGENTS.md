# Syra

> Org-wide engineering standards (TypeScript, React, naming, error handling, security, testing, git, bun) live at <https://github.com/OxyHQ/engineering/blob/main/AGENTS.md> and are not repeated here. This file holds ONLY Syra-specific content.

## Monorepo Structure

| Package | Path | Role |
|---------|------|------|
| `@syra/frontend` | `packages/frontend/` | Expo app — syra.fm |
| `@syra/backend` | `packages/backend/` | Express API |
| `@syra/studio` | `packages/studio/` | Creator studio portal |
| `@syra.fm/sdk` | `packages/sdk/` | Public SDK |
| `@syra/shared-types` | `packages/shared-types/` | Shared TypeScript DTOs |

## A type error in a test file is invisible to the suite AND to the build

Only `bun run typecheck` sees it. Measured in `packages/backend` by introducing
one TS2345 and running all three:

| command | result |
|---------|--------|
| `bun test` | **passes** — bun strips types, it never checks them |
| `bun run build` | **passes** — `tsconfig.build.json` excludes `**/*.test.ts` and `src/test/**` |
| `bun run typecheck` | **1 error** — `tsc --noEmit` over the whole project |

So after ANY change to a test file or a test-only helper, run `bun run
typecheck`; a green suite and a green build together still prove nothing about
whether it compiles. When reporting verification, name the packages typechecked
rather than folding it into "tests pass" — the two are not the same check.

## AWS Deployment

- **Port**: `3000` (deployed; ECS sets `PORT` explicitly — the local dev default is `4120`) | **Domain**: `api.syra.fm`
- **Deploy**: `.github/workflows/deploy-aws.yml` → `linux/arm64` Docker → ECR `237343248947.dkr.ecr.us-west-2.amazonaws.com/oxy/syra` → `ecs update-service --force-new-deployment`
- **Secrets**: GitHub Actions secrets → SSM `/oxy/syra/*`.

## Domains

Production: web `https://syra.fm`, API/WebSocket `https://api.syra.fm` / `wss://api.syra.fm`. Do not restore retired Syra oxy.so hosts in runtime config, CORS, EAS env, universal links, or deployment scripts.

## Oxy Integration

- Gate private API calls (library, playlists, artist profile, privacy, preferences, recommendations) with `useAuth().canUsePrivateApi` / `isPrivateApiPending` — not app-local token helpers.
- `packages/frontend/utils/api.ts` owns the linked authenticated Syra API client via `oxyServices.createLinkedClient(...)`. Components/hooks must not hand-roll auth headers, refresh, CSRF probing, or session invalidation.

## Frontend State Architecture

- **TanStack Query** for server state: catalog reads, library, playlists, artist profile, preferences, recommendations, privacy.
- **Zod** at API boundaries: parse once in the service layer, return typed data, fail loudly through the existing error path.
- **Zustand** only for local-only state: player state, queue UI state, session-independent UI preferences, transient interaction state. Do NOT mirror liked tracks, playlists, or profile data in Zustand when TanStack Query already owns that remote state.
- Mutations must invalidate relevant TanStack Query keys immediately — like/unlike must update the button, library lists, album/track screens, and player state without reload.
- Queue/playback Zustand state may optimistically update but must persist through `queueService` and repair backend drift by replacing the queue, not hiding 400 errors with local-only state.

## Catalog — Implementation Rules

Syra is an own-catalogue platform: every track is Syra-hosted, so a track is playable iff it is available and not copyright-removed — no provider dimension, no deployment flag, no per-user variation. The single predicate lives in `playableTrackFilter()` (`packages/backend/src/db/catalog/visibility.ts`); every catalog/playback read goes through it rather than reimplementing the check.

**Music enters through exactly one path: creator upload.** The upload endpoint in `tracks.controller` builds the `Track` directly and calls `enqueueIngest` to start HLS transcoding (`status: processing → ready | failed`). There is no external ingest — no connector layer, no import service, no provider reconciliation, and no dormant pipeline to revive. Adding an external source means building one from scratch; do not assume a hook exists. (Podcasts are a separate vertical and DO mirror external RSS — see the podcast import services.)

- Track-bearing containers (albums, artists, playlists, genre cards, search/browse) must be filtered by the same playable-track predicate. Do not show a container as playable if opening it returns zero playable tracks. An album also carries its own `isAvailable`, so a creator can unpublish the container while its tracks stay individually discoverable.
- The catalog authority and the playback authority must agree. `playableTrackFilter` gates listing; `isTrackPlayable` (`stream.controller`) gates playback. Any field that hides a track from one MUST hide it from the other, or takedowns stay listed and searchable and then fail at play. `isPlayableTrack` is the in-memory twin of the SQL predicate — change them together.
- Catalog reads that vary by identity must use the linked Oxy client (`packages/frontend/utils/api.ts`), not `publicApi`.
- Identity-sensitive catalog queries must wait until `useOxy().isPrivateApiPending` is false and must separate React Query cache keys for `guest` vs `auth`. Never let a guest cold-boot response populate the authenticated cache.
- The player resolves playback through `GET /stream/:trackId`; the backend is the sole entitlement authority.
- Catalog filters compose with drizzle's `and()` — `and(playableTrackFilter(), …)`. There is no counterpart to the old `andMongoFilters`, and none is needed: `and()` takes conditions as arguments, so it cannot lose a term the way spreading two filter objects silently dropped an earlier `$or`. A pool or query that passes an `or(...)` keeps it (`services/radio/radioPools.ts`).
- Playlist readability DOES vary per viewer, unlike track playability: `canViewPlaylist()` (`db/catalog/visibility.ts`) is the single predicate — public to anyone, otherwise owner or collaborator only. Every surface that exposes a playlist asks it, so the rule cannot change in one place and miss another.

## Server-only fields — the protected-column registry is the guard

A field is kept out of a response by ONE mechanism: `PROTECTED_COLUMNS_BY_TABLE`
(`db/schema/protectedColumns.ts`). `db/catalog/serialize.ts` derives its row
shapes from the drizzle table type MINUS that table's protected columns
(`PublicTrackRow = Omit<typeof tracks.$inferSelect, …>`), so the registry is the
single source of truth and **a serializer that still names a newly-protected
column stops compiling**. That is strictly stronger than anything a serializer
can do by hand, because it fails before the code runs rather than on the one
route nobody exercised.

Two rules survive from the denylist era, and both are about how you VERIFY a
guard rather than which guard you picked:

- **An allowlist beats a denylist, so prefer a DTO that names every key it
  returns** (`toTrackDto`, `toAlbumDto`, `toUploadTrackDto`). A field added to
  the table tomorrow is excluded by default. Do NOT add a `delete` beside one: it
  can never fire, and it advertises a denylist where the real guard is an
  allowlist.
- **Mutation-test which guard is load-bearing** — remove it and confirm the test
  goes red naming the field. And never read a guard's presence from its comment;
  a guard can be removed while the comment asserting it survives.

`controllers/serverOnlyFields.leak.test.ts` is the standing gate for the whole
class, and covers the catalogue, the locker (`user_uploads`) and attestations in
one place. Its header records what the leak looked like when the guards were a
Mongoose `select: false` plus an untyped spreading formatter — both of which are
gone. Keep that history: it is why the registry exists.

Not a leak, and must not be "fixed" into one: `catalog_entities`' four
`imageLicence*` columns are public on purpose. CC BY-SA is satisfied BY
displaying the author and licence; hiding them would be the breach.

## A zod DTO field with no storage is invisible to `tsc`

Because the zod schema is the source of the TypeScript type, a DTO field can
never disagree with itself — so nothing at compile time notices a field that is
in the contract, returned to clients, asserted by a passing test, and stored
nowhere. That was `catalog_entities.members`, which had a live reader.

`src/db/__tests__/zodPathsExistInDrizzle.test.ts` is the standing gate: every
zod DTO field must resolve to a drizzle column, a foreign key, a child table or
an explicit registry entry. When adding a field to a DTO, add its storage in the
same change.

**Half of the original problem is gone and half is not.** Drizzle rejects an
unknown column key at COMPILE time, where Mongoose strict mode dropped a `$set`
on an undeclared path in silence — that direction no longer needs a runtime gate.
The direction above still does, because nothing forces a DTO to be written
through a table at all.

Two traps the gate handles structurally, both worth knowing when reading it:

- **Flattening.** The port turned subdocuments into column prefixes
  (`links.wikidata` → `links_wikidata`, `cache.s3Key` → `cache_object_key`), and
  replaced others with a foreign key (`imageSizes.small` → `image_sizes_small_id`
  → `image_assets`). A naive one-to-one name match reports a correct schema as
  broken. The rule that covers flattening, `jsonb` subdocuments and foreign keys
  at once is **descend only into what does not already resolve**.
- **`ZodArray.unwrap()` returns the ELEMENT type in zod 4.** An unwrap loop that
  calls `.unwrap()` on anything that has it will walk into array items — the
  Mongoose gate did exactly this, against its own comment saying it did not.
  Unwrap optionality only, so an array stays one path.
