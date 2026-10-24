# First-party SDK transport

Source implementation, 2026-10-23; not a claim of deployment.

`syraForOxySession(existingOxyServices)` creates a linked authenticated client.
Own apps must use this shared lifecycle instead of a copied bearer callback.
Account identity remains the verified Oxy session; there is no app scope or
connection consent. Existing external `createSyraClient({ getAccessToken })`
behavior and ticket-only episode ingest remain supported.

HTTP composition tests cover account switch, revocation, redirects, disposal,
external callbacks and ingest/storage credential separation. SDK typecheck
includes the new transport tests explicitly; the build excludes tests.

The public factory requires Oxy core `>=7 <8`, declared as an optional peer;
headless anonymous/external SDK users need no Oxy dependency. Core 6.15.1 was
checked and lacks the linked `fetch` API, so it is not claimed as compatible.
SDK development gates use published core 7.0.0/contracts 6.0.0 and services
13.0.0. The optional services peer also accepts major 13. Runtime Zod requires
the patched `^4.6.7` version.

The SDK-only release leaves backend/frontend/studio direct pins unchanged.
Global Oxy overrides were removed so packages resolve their actual dependencies:
the SDK gets core 7/contracts 6/services 13; the existing backend gets core
6.15.1/contracts 5.7.0, and the existing apps get services 12.12.0 with core
6.15.1. This resolution was checked from each installed package, including the
services package's own core dependency; there are no test aliases or local paths.

Release this SDK minor through Actions after CI, then adopt it in Mention and
other frontends. Backend workload migration, audio/File streaming and other
consumers remain a separate rollout. This SDK change does not mark them complete
or retire Oxy's finite legacy workload bridge.

Published dependency validation: frozen install, all 344 SDK tests across 14
files, SDK production/test typechecks and all build formats pass. The unchanged
backend also passes its 458-file typecheck using its existing core 6 dependency.
Biome and the agent-instruction budget pass. CI and package publication remain
pending; these local gates do not claim a deployed SDK or backend.
