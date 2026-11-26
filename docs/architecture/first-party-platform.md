# First-party platform migration

The source is composed against published packages; runtime deployment remains a
separate step. The coordinator verified the Oxy protocol-2 receiver live before
this producer rollout.
Oxy's first-party decision supersedes the internal scopes/key instructions in the
historical image/audio migration runbooks. Customer credentials and external OAuth
remain bounded; a Syra brand or local owner identifier never supplies user authority.

| Edge | Source state | Remaining acceptance |
| --- | --- | --- |
| Syra → Oxy notifications | Shared workload protocol-2 transport, existing suppression and failure behavior | Registry core 7.3 pinned; producer canary pending |
| Syra → Oxy Files application media/references/play sessions | Shared OxyServer AWS workload provider; no key fallback or ECS-only readiness gate | Registry core 7.3 pinned; outbox and signed playback canary pending |
| Syra activity → Oxy | Shared traffic publisher with temporary workload provider | Registry core 7.3 pinned; producer canary pending |
| Personal image and audio uploads → Files | `assets.actingFor` the signed-in account (and the person operating it) on Syra's declared `oxy:files` write (oxy ADR 0066) | Production canary after the declarations deploy |
| House/room/series images → Files | New assets application-owned; historical file IDs unchanged | Same local roles, reference replacement, no deletion of personal owner's file |
| Asynchronous podcast/locker ingest → Files | `actingFor` the row's owner, with `operator_oxy_user_id` when a person operated it; nothing to renew | A refused copy keeps the existing playback path |
| Syra moderation → CrowdSource | Own outbox uses injected shared OxyServer; delivery signature retained | Registry CrowdSource 3.1 pinned; receiver live; preserve durable outbox and verify canary |
| Other apps → Syra SDK | Main `772869c` contains the linked factory and corrective SDK 0.23 release | Verify published 0.23 bytes before caller pins; 0.22 is the older artifact |
| Syra frontend/studio → own API | Shared linked clients; privacy reads separated by verified viewer and session change; Studio uses provider account cache | Verify caches and receiver composition with core 7 |

Application-owned audio and audio referenced by Syra keep the Files application
entitlement lane. Listener IDs are attribution, not requester proof. The signed
`stream.key_authorization` webhook still decides playback access. Its webhook
secret is a delivery signature and stays; it is not an internal API credential.

## Acting for people (oxy ADR 0066)

Oxy's own services never ask people for permissions, tasks or sessions as proof.
Syra's entry in oxy's first-party registry declares `oxy:files` write, so a
personal file (an uploaded image, a locker file, a hosted episode, including one
an MCP client generated) is written with `oxy.assets.actingFor({ accountId,
requesterAccountId? })` (`services/oxyFiles/actingFor.ts`): the owner, and the
person operating it when it is an organization. Oxy checks the declaration and the
accounts live on every call; Syra's own rules (ownership, visibility) run as before.
Background work names the same accounts from the row: `user_uploads` and
`episodes` carry `operator_oxy_user_id` (`0042`, server-only), and the task
handles, their revocation outbox and triggers are gone (`0043`, post phase).

Workload identity is resolved lazily using temporary AWS role/SSO credentials,
including outside ECS. Failed outbox attempts keep the existing durable retry
state; absence of container environment variables does not disable delivery.

Workload transport checkpoint validation: 73 notification, Files and activity tests
passed against a disposable PostgreSQL database, including real HTTP mint and
redirect/revocation failures. Backend source/test typecheck, build, changed-file
Biome and AGENTS checks passed. Candidate package overrides were restored.

Shared house/room/series artwork now belongs to Syra's application resource.
Replacing a historical personal image releases only its reference, never deletes
that person's file or grants the admin access to their private Files. Local role
and visibility checks remain authoritative for the shared space. This supersedes
the historical runbook's assumption that a space admin may store into the creator's
personal account. Existing file IDs and ownership are not converted.

Shared-space/outbox checkpoint: 77 platform tests passed, including a real HTTP
admin upload that replaces a personal image reference without deleting the file,
a denied non-admin upload, and own moderation configuration without a customer
key. Backend source/test types and changed-file Biome passed. Registry pins await
the released CrowdSource outbox provider addition.

The completed rollout boundary is `0038_retire_legacy_image_storage`, whose
SHA-256 is `aef8f91aa9bb0beae0648f84c441d4fb1a4454795fb5314af9f932597bfe7632`.
A production read-only check at `2026-10-23T20:43:32.451Z` found exactly one matching
row in `drizzle.__drizzle_migrations` (running source `oxy-syra:169`). Operational
receipt: `.scratch/first-party-root/syra-migration-0038-readback.json` in the shared
workspace. The check's task exited successfully and its temporary definition was
retired. This evidence closes the historical rollout window, not the frozen
`0024_ambitious_xorn` genesis boundary. The gate validates ordering within both
windows. A fresh disposable PostgreSQL database created from `template0` applied
all 40 migrations, `0000` through `0039`; none were skipped. Runtime migration
selection still uses the target database's actual journal. `0041` (post) was
applied in production on 2026-11-14 (the ledger's 42nd row, read-only) and closes
the next window, so `0042` (pre) and `0043` (post) open a new one.

Frontend account review: the unscoped privacy AsyncStorage cache is retired and
never read. Queries include the verified viewer, target profile and session epoch;
a response from an earlier account cannot populate the current view. Offline or
signed-out reads do not fall back to another account's settings. Studio now gives
its existing QueryClient to OxyProvider with all account queries scoped, matching
the main app. (Services 15, 2026-11-26: OxyProvider takes no QueryClient; both
apps scope their own queries, see `docs/agent-rules/frontend-state.md`.) Two real React Query regressions cover account switch/logout and a
late response. Frontend and Studio typechecks pass with the candidate core.


## Registry composition, 2026-10-25

The runtime is rebased on SDK release main `772869c`, preserving the intervening
Expo and Android changes. It pins public core 7.3.0, contracts 6.0.0, services
13.0.0, protocol 1.5.1 and CrowdSource core 3.1.0/contracts 1.1.1. Candidate Oxy
installations were removed; isolated-cache registry installation and frozen lock
verification pass. The installed Oxy contracts declaration matches the real Zod 4
registry bytes. Public Syra contracts 0.2.1 raises its runtime Zod floor to
`^4.6.7`; the schema/API is unchanged. SDK source from PR 251 also has that
patched floor. Registry 0.22.0 predates this source: its verified npm provenance
points to `039ea484411cd2c70729dd8add6cff4e216434cf` and release run
39952355499, and its tarball lacks the session factory and focused entries.
External consumers must verify the corrective 0.23 release and its actual
exports before pinning; the version number alone is insufficient. This app's workspace
build consumes the reviewed source, not that older public tarball.

A fresh disposable PostgreSQL database applied all 40 migrations. Registry gates
pass: 85 platform tests, 82 personal-file tests, 150 audio/task tests and 113
schema/protected-column tests; suites overlap and are not a unique-test total.
The two React Query account/session-isolation tests pass. Backend (464 files),
frontend and Studio types, SDK build formats and backend build pass, together
with Doctor, Biome and AGENTS checks.

The clean frontend web export passes every unchanged budget: initial JavaScript
7,899,833 bytes (2,014,907 gzip), deferred translations 1,247,628 (424,927 gzip),
other JavaScript 2,817,634 (800,503 gzip). The minifier no longer adds optional
parentheses around immediate function calls; JavaScript-required parentheses
remain. This removes redundant output rather than increasing a budget.

These are source/release gates, not a claim of runtime deployment. Historical
personal files are not converted or erased by this rollout.

## Rolling deployment and rollback

`0042` (pre) adds the nullable `operator_oxy_user_id` columns before the new image
starts; the previous image keeps writing `oxy_task_id` until it drains. `0043`
(post) then drops the triggers, `oxy_file_task_revocations` and `oxy_task_id`.
Production held no task handle or queued revocation when it was written (counted
read-only on 2026-11-14), and every task Syra minted expired within a day. Once
`0043` has run, do not roll back to an older image: it still writes `oxy_task_id`.

## Alia client transport

The frontend uses the published `@gemies/sdk` (formerly `@alia.onl/sdk`), which talks to
`https://api.gemies.ai`. Alia owns conversation, history, streaming and audio
transport through the shared Oxy session; the app keeps its existing provider,
agent selection and UI. No app-local bearer refresh or internal permission prompt
is introduced.

### Realtime session follow-up

SDK 0.24.0 adds leased room sockets using shared Oxy session authority, with
immediate account-epoch teardown and no copied bearer callback. Syra player
presence uses the same shared getter contract and clears account-bound device
registration on teardown. See `docs/first-party-sdk.md` for tests and the
minimum published core version. Mention must adopt the verified registry
artifact after Actions publishes it; the finite v1 bridge remains gated on
all outstanding fleet and operational checks.

A final tracked-source census found the old frontend `playlistSocketService`
module had no importers or runtime callers (only a historical inventory mention
in `AUDIT.md`). It has been removed, rather than retaining its unused copied-token
transport. Active playlist HTTP/domain behavior is unchanged.
