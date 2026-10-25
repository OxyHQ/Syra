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
| Personal image uploads → Files | Foreground requester proof bound to verified effective account; never persisted | Registry core 7.3 pinned; managed-account and revocation canary pending |
| Personal audio uploads → Files | Original task admitted with verified session; only its handle is stored | No owner-ID fallback; retain account isolation and revocation |
| House/room/series images → Files | New assets application-owned; historical file IDs unchanged | Same local roles, reference replacement, no deletion of personal owner's file |
| Asynchronous podcast/locker ingest → Files | Original task persisted at verified draft/upload admission | Ticket contract unchanged; old missing-proof rows cannot create new personal files |
| Syra moderation → CrowdSource | Own outbox uses injected shared OxyServer; delivery signature retained | Registry CrowdSource 3.1 pinned; receiver live; preserve durable outbox and verify canary |
| Other apps → Syra SDK | Main `772869c` contains the linked factory and corrective SDK 0.23 release | Verify published 0.23 bytes before caller pins; 0.22 is the older artifact |
| Syra frontend/studio → own API | Shared linked clients; privacy reads separated by verified viewer and session change; Studio uses provider account cache | Verify caches and receiver composition with core 7 |

Application-owned audio and audio referenced by Syra keep the Files application
entitlement lane. Listener IDs are attribution, not requester proof. The signed
`stream.key_authorization` webhook still decides playback access. Its webhook
secret is a delivery signature and stays; it is not an internal API credential.

New personal files require the exact original effective account plus verified
session/task proof. Existing audio remains playable under its current domain
entitlement. A historical row lacking proof must not create a new personal Files
copy by guessing its owner; it waits for an ordinary verified owner action.

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

Personal image checkpoint: 82 image, upload and direct-audio regression tests
passed, plus backend source/test typecheck. Tests reject missing/cross-account
proof before a personal write and verify the transient session is absent from
stored rows. Embedded artwork uses the same original upload session.


Personal audio task checkpoint (source only): locker and podcast admissions create
an Oxy goal with the original requester and effective account, expiring after 24
hours. Background ingest passes that exact task to Files; it never stores a user
bearer. The existing single-use podcast ingest ticket retains its 24-hour domain
contract. A managed account keeps its human requester separate from the account
whose audio is stored. Missing or revoked proof cannot authorize a personal copy;
existing legacy audio playback remains available under the existing entitlement.
An ordinary owner re-upload can renew an uncopied locker item's task using a
compare-and-set update without changing the item's identity or asking for Oxy
permissions. Historical podcast copies without proof remain pending; no owner is
inferred from the show record to create authority.

Migration `0039_magenta_otto_octavius` adds nullable task handles and a durable
revocation queue. Database triggers retain the old handle on replacement, direct
deletion and parent cascade; a failed admission also queues its new handle.
Delivery retries until Oxy confirms revocation. Task handles are server-only
protected columns and do not enter public episode or locker responses.

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
selection still uses the target database's actual journal. Migration 0039 has
only been applied to disposable test databases, not production.

Audio checkpoint validation: 150 audio, admission, ingest and task-authority tests
passed, including real HTTP workload minting, managed accounts, revocation,
cascade deletion, replacement, failed insertion and ordinary owner re-upload.
The schema/public-field suites passed 113 tests. Backend source and test types,
build, changed-file Biome and AGENTS checks passed. Local candidates were used
only for validation; production deployment and registry pins remain pending.


Frontend account review: the unscoped privacy AsyncStorage cache is retired and
never read. Queries include the verified viewer, target profile and session epoch;
a response from an earlier account cannot populate the current view. Offline or
signed-out reads do not fall back to another account's settings. Studio now gives
its existing QueryClient to OxyProvider with all account queries scoped, matching
the main app. Two real React Query regressions cover account switch/logout and a
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

These are source/release gates, not a claim of runtime deployment. Apply the
additive task-authority migration in its reviewed pre phase, then deploy and
verify original-account uploads, durable ingest, revocation outbox and playback.
Historical personal files are not converted or erased by this rollout.

## Rolling deployment and rollback

Apply migration 0039 in the normal pre phase before starting new API or ingest
processes. It adds nullable columns, a revocation queue and triggers; existing
processes can continue using the old schema projection. It does not backfill a
task from an owner ID or change any existing file ownership. New admissions store
only the task handle, and replacement/deletion queues revocation durably.

During a mixed-version rollout an old writer may still create a row without a
task. New workers preserve that row and any existing playable audio, but cannot
copy it into personal Files until an ordinary verified owner action admits the
original authority. Do not delete/reclassify those records to clear a queue.
Verify that all API, ingest and scheduled/one-shot producers have switched before
retiring Oxy's central finite compatibility cohort. Replaying pending revocations
must remain enabled during the transition.

Rollback keeps migration 0039 and its queued revocations: do not drop task columns
or the outbox to match an older image. The earlier image is only a temporary
rollback while its verified legacy workload remains accepted; it is not a way to
regain broad personal-file authority after the compatibility cohort is removed.
Any task already admitted still has its original account and expiry. Operational
canaries must check new personal upload, existing audio playback, shared-space
replacement without personal-file deletion, moderation delivery and task revocation.

The operator audio migration uses the same stored original-task lookup as
asynchronous ingest. A row readmitted through the ordinary verified owner flow
can be copied with that task; a historical row without proof remains unchanged.
CI regression coverage includes both cases and the live ingest ticket refusing
deletes. The isolated receiver probe disposes its OxyServer before exit so its
background connections do not outlive the test; its timeout was not increased.


## Alia client transport

The frontend source uses the published `@alia.onl/sdk` 22.0.0 with the existing
Core 7.3 / services 13 stack. Alia owns conversation, history, streaming and audio
transport through the shared Oxy session; the app keeps its existing provider,
agent selection and UI. No app-local bearer refresh or internal permission prompt
is introduced. Package installation was checked against the published artifact;
source adoption and deployment are separate rollout steps.

### Realtime session follow-up

SDK 0.24.0 adds leased room sockets using shared Oxy session authority, with
immediate account-epoch teardown and no copied bearer callback. Syra player
presence uses the same shared getter contract and clears account-bound device
registration on teardown. See `docs/first-party-sdk.md` for tests and the
minimum published core version. Mention must adopt the verified registry
artifact after Actions publishes it; the finite v1 bridge remains gated on
all outstanding fleet and operational checks.
