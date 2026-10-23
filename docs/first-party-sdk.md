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

Release order: publish Oxy core 7, update this repo's test dependency override,
run SDK gates with registry dependencies, release an SDK minor, then adopt the
helper in Mention and other frontends. The source tests currently use local
candidate tarballs only. Backend workload migration, audio/File streaming and
other consumers remain separate pending work; this change does not mark them
complete or retire Oxy's finite legacy workload bridge.
