# Ecosystem activity

Each deployed API process publishes bounded activity aggregates to Oxy, whether
or not anyone has opened the dashboard. HTTP middleware observes requests and
completed responses, including errors; the shared outgoing observer covers fetch
and Node HTTP clients. Requests and responses have independent directions.
Socket.IO application events and observed raw WebSocket messages are counted
separately from HTTP. Ping/pong frames and Socket.IO acknowledgements are not
application events.

The publisher sends only service identities, infrastructure regions, coarse edge
PoPs, direction, scope, category and aggregate counts. It never sends payloads,
paths, query strings, IPs, user IDs, credentials or socket IDs. A Cloudflare PoP
is a network ingress location, not a visitor's physical location.

`OXY_ECOSYSTEM_ACTIVITY_ENABLED=true` explicitly enables the deployed producer; it is disabled by default. Keep it false in local environments, even when using AWS storage.

`AWS_REGION` supplies the process location. Publication uses temporary workload
identity through the shared Oxy producer and its AWS credential provider
(`packages/backend/src/services/platformActivity.ts`). ECS task roles and other
registered temporary assumed-role credentials are authenticated by Oxy's live
workload binding; customer API keys are not an alternative for this own producer.
Do not provision `OXY_ACTIVITY_API_KEY`/`OXY_ACTIVITY_API_SECRET` or
`OXY_SERVICE_API_KEY`/`OXY_SERVICE_API_SECRET` for activity publication.

Each process registers a fresh instance, refreshes its lease and removes it
during graceful shutdown. Crashed instances disappear when their lease expires.
Oxy broadcasts authoritative snapshots over Socket.IO. The activity field named
`scope` classifies traffic as internal/external; it is not an OAuth permission
or a per-application access grant.

Counters describe observed application operations, not network bytes. Direct
object-storage downloads, media transports, database wire protocols and third
party runtime internals require instrumentation at their owning services.

## Static edge requests

This app's web traffic (both Pages projects) is measured keylessly by Oxy from
Cloudflare analytics — see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`.
The app holds no Oxy activity secret and runs no activity code; the root
`functions/_middleware.ts` is a plain pass-through. The `OXY_EDGE_ACTIVITY_*`
bindings were never provisioned and nothing reads them now, so if one is ever
found on a deployment it can simply be deleted.

## Package versions

Core and contracts are aligned through workspace overrides so browser and server packages share one version. Run the Pages middleware check in `scripts/pages-middleware.test.ts` alongside the existing package checks.
