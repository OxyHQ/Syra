# Syra MCP server

`https://api.syra.fm/mcp` exposes Syra to any MCP client — Claude, a gemie through the
Gemies Connectors Store, any other agent. Code: `packages/backend/src/mcp/` (`catalog.ts`
tools, `index.ts` transport and registration).

## Connecting

Add a custom connector with the URL `https://api.syra.fm/mcp` and let the client sign in. It
discovers Oxy from the 401 challenge and `/.well-known/oauth-protected-resource/mcp`,
registers itself with Oxy dynamically, and the person approves the connection on
auth.oxy.so. There is no key to create or paste; access is revoked from Oxy Settings.

## Tools

| Tool | Scope | Does |
|---|---|---|
| `search-catalogue` | `syra.read` | tracks, albums, artists, playlists, podcasts, episodes: exactly what the public `GET /api/search` answers an anonymous listener |
| `list-my-podcasts` | `syra.read` | the acting account's shows, in every state |
| `get-podcast` | `syra.read` | one show: theirs in any state, anyone's when public or unlisted |
| `list-podcast-episodes` | `syra.read` | a show's episodes; on their own show, the ones still being made too |
| `get-episode` | `syra.read` | one episode and its listen link |
| `generate-episode` | `syra.write` | write and voice an episode of their show (`podcastId`), or of a new private one (`newPodcast`); returns at once ([generated episodes](./podcast-generation.md)) |
| `get-generation` | `syra.read` | where one generated episode has got to, or why it failed |
| `list-generations` | `syra.read` | a show's generated episodes and their status |

Every tool acts as the connection's **active account**, the one Oxy reports on live
introspection, and reads through the same viewer rules as the app (`findPodcastForViewer`,
`findEpisodeForViewer`, `episodeVisibilityFilter`). `generate-episode` takes an
`idempotencyKey`: asking again with it answers the first request instead of starting, and
paying for, another (`episode_generations.idempotency_key`).

An MCP connection holds no Oxy session, so an episode it generates keeps Syra's copy of the
audio rather than becoming the person's own Oxy file (see
[audio ownership](./podcast-generation.md#audio-ownership)).

## How it is wired

- **Stateless transport** (`@oxy.so/mcp` `createCatalogMcpHttpService`), mounted in
  `server.ts` before the API's CORS, rate limiter and JSON parser: it reads its own body,
  answers its own CORS and checks every request's token live against Oxy
  (`/auth/mcp/oauth/introspect`) with Syra's workload transport.
- **Catalogue registration.** Oxy issues tokens only for a resource a registered catalogue
  declares. In production the API registers `SYRA_MCP_CATALOG` at boot
  (`registerMcpCatalog`), retrying an Oxy outage with capped, jittered backoff and stopping on
  a configuration refusal. It needs `catalogs:write` and the `catalog:syra` capability on the
  Syra application (oxy `seedOxyApplicationsSpecs.ts`, applied by the Seed Oxy applications
  workflow).
- **Adding a tool** is an entry in `TOOLS` (`catalog.ts`); the catalogue, its JSON schemas and
  the handler table are built from it at import, so a malformed tool fails the boot.
