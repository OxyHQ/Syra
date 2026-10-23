# First-party platform migration

Source checkpoints only. Deployment and final published package pins are separate
steps; the Oxy protocol-2 receiver must be live before this producer is deployed.
Oxy's first-party decision supersedes the internal scopes/key instructions in the
historical image/audio migration runbooks. Customer credentials and external OAuth
remain bounded; a Syra brand or local owner identifier never supplies user authority.

| Edge | Source state | Remaining acceptance |
| --- | --- | --- |
| Syra → Oxy notifications | Shared workload protocol-2 transport, existing suppression and failure behavior | Core 7 release/pin, receiver first, canary |
| Syra → Oxy Files application media/references/play sessions | Shared OxyServer AWS workload provider; no key fallback or ECS-only readiness gate | Core 7 release/pin, receiver first, outbox and signed playback canary |
| Syra activity → Oxy | Shared traffic publisher with temporary workload provider | Core 7 release/pin and producer canary |
| Personal image/audio uploads → Files | Pending original requester/session/task propagation | No owner-ID fallback; retain account isolation and revocation |
| House/room/series images → Files | New assets application-owned; historical file IDs unchanged | Same local roles, reference replacement, no deletion of personal owner's file |
| Asynchronous podcast/locker ingest → Files | Pending root persisted at verified request admission | Ticket contract unchanged; old missing-proof rows cannot create new personal files |
| Syra moderation → CrowdSource | Own outbox uses injected shared OxyServer; delivery signature retained | Publish/pin CrowdSource SDK including 44d2a2972; receiver first; preserve durable outbox |
| Other apps → Syra SDK | Separate source branch `657e15d` has linked session factory | Publish/pin and integrate SDK source; no deployment claimed |
| Syra frontend/studio → own API | Existing shared linked client; further account-switch audit pending | Verify caches and receiver composition with core 7 |

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
