# First-party SDK transport

Source implementation, 2026-10-23; not a claim of deployment.

`syraForOxySession(existingOxyServices)` creates a linked authenticated client.
Own apps must use this shared lifecycle instead of a copied bearer callback.
Account identity remains the verified Oxy session; there is no app scope or
connection consent. Existing external `createSyraClient({ getAccessToken })`
behavior and ticket-only episode ingest remain supported.

HTTP composition tests cover account switch, revocation, redirects, disposal,
external callbacks and ingest/storage credential separation. The independent
`tests/sdk-transport` consumer harness imports the SDK package's built main/types
entries and uses published core 7.0.0/contracts 6.0.0. Its package and frozen lock
are separate from the runtime workspace; CI explicitly installs it, checks its
types and runs the HTTP tests after building the SDK. No implementation is copied,
and no package alias or local dependency path is used.

The structural own-session factory requires core 7 because core 6.15.1 lacks
linked `fetch`; anonymous/external clients need no Oxy dependency. Oxy is not
imported by the factory, so no runtime peer forces a version into those callers.
The optional services peer accepts major 13, also validated in the earlier
composition check. Runtime Zod requires the patched `^4.6.7` version.

The SDK-only release preserves all runtime pins and global singleton overrides:
core 6.15.1/contracts 5.7.0 and services 12.12.0 remain in the main workspace.
Oxy Doctor passes without disabling or weakening its duplicate-version checks.
The separate consumer harness is necessary only while the runtime remains on
core 6; it can be simplified after the core 7 runtime migration.

Release this SDK minor through Actions after CI, then adopt it in Mention and
other frontends. Backend workload migration, audio/File streaming and other
consumers remain a separate rollout. This SDK change does not mark them complete
or retire Oxy's finite legacy workload bridge.

Published dependency validation: 338 SDK tests plus six HTTP consumer tests,
SDK and consumer typechecks and all build formats pass. The unchanged backend
also passed its 458-file typecheck using core 6. Doctor, Biome and the agent
instruction budget pass. CI and package publication remain pending; these local
gates do not claim a deployed SDK or backend.

The SDK also exposes focused `/live` and `/upload` entries. Syra's existing
frontend uses those entries without changing its authentication or runtime pins;
this keeps the new headless session factory out of its initial bundle. Direct
upload tests and frontend types cover the equivalent imports. The web budget
limits remain unchanged and CI checks the actual exported application.

The existing Metro minifier now chooses the shorter quote form for strings,
instead of preserving source quotes. This removes avoidable escaping in deferred
translations without changing their text. A fresh frozen install and clean web
export pass every unchanged budget: initial JavaScript 7,886,263 bytes (2,011,586
gzip), translations 1,247,628 (424,993 gzip), other JavaScript 2,817,757 (800,547
gzip). SDK 338 tests, six real HTTP transport tests, four frontend upload tests
and frontend/SDK typechecks also pass. These measurements are local evidence;
Actions still validates the release commit.


## Public artifact correction

Registry SDK 0.22.0 predates this implementation. Its npm provenance names source
`039ea484411cd2c70729dd8add6cff4e216434cf` and Actions run 39952355499; its tarball
has no session factory or focused `/live` and `/upload` entries and retains the
older Zod floor. PR 251 source alone therefore did not make the factory available
to external consumers. Version 0.23.0 publishes the reviewed additive factory and
entries with patched Zod. After Actions publication, verify the tarball exports
and declaration files before pinning consumers; a version lookup alone is not
evidence that the desired artifact was released. This patch changes no backend
workload implementation or app dependency pins.

## Live session sockets in 0.24.0

`RoomSocketService.connectWithOxy(oxy, onContextEnd?)` obtains each Socket.IO
handshake through `createLinkedClient().getAccessToken(target, { signal })`.
It returns a release function for that consumer. Concurrent consumers share
one connection for the same provider and session epoch; releasing one leaves
other leases alive. The last release cancels a pending handshake. Account
switch or logout immediately disconnects the old socket and notifies every
lease; late releases cannot affect the next account's connection.

The live React hook uses this method and clears previous participants and
recording state when authority changes. The narrow `@syra.fm/sdk/live/socket`
entry exposes the transport without loading React or native audio. Existing
`connect(userId, token?)` remains the explicit external credential API; it is
never used to infer first-party authority.

The live transport requires published Oxy core >=7.1.0 <8.0.0 (optional peer).
Headless HTTP factories are unchanged. `tests/sdk-sockets` has its own frozen
lock on core 7.1.0, extracts the actual `bun pm pack` artifact, imports its public
socket entry and verifies connected account switches with real Socket.IO. It
keeps the minimum-version test independent from the app's newer core version.
The earlier headless core 7.0 harness remains separate and unchanged.

Syra's player presence also uses the shared target-bound handshake. Effect
cleanup cancels pending authentication; old account device registration is
cleared, and a late cleanup cannot disconnect the replacement socket. The
normal device registration, reconnect registration and heartbeat protocol remain.

Local gates: 342 SDK tests, 294 frontend tests, SDK/frontend/test typechecks,
all SDK build formats and the packed core-7.1 composition test. Publication and
Mention's subsequent registry pin are separate gates; this source does not
activate legacy workload retirement.
