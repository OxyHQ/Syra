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
