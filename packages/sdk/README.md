# @syra.fm/sdk

Isomorphic client for the public [Syra](https://syra.fm) API. The package
resolves per platform via export conditions:

- **Node / bundlers** (`require`/`import`) get the **headless catalog client** —
  runs on Node 18+ and browsers, no React, React Native, or DOM dependencies,
  and no Zod: responses are checked in plain TypeScript.
  [`zod`](https://zod.dev) is a dependency only of `@syra.fm/sdk/schemas`.
- **React Native** (Metro) and **Expo web** (`browser`) additionally get the
  **live-rooms engine** (audio rooms over LiveKit) and the `SyraIcon` brand mark.
  Its React Native / LiveKit / Expo dependencies are declared as **optional peer
  dependencies**, so headless Node consumers never install them.

Everyone imports from the same `@syra.fm/sdk` root — the condition picks the
right surface.

## Install

```sh
bun add @syra.fm/sdk
```

## Usage

```ts
import { createSyraClient } from '@syra.fm/sdk';

const syra = createSyraClient(); // defaults to https://api.syra.fm

// Search the catalog — returns one page; only tracks with a public preview are
// in `items`. Paginate for infinite scroll by advancing `offset` by `limit`.
const page = await syra.searchTracks('lofi beats', { limit: 10, offset: 0 });
if (page.hasMore) {
  const next = await syra.searchTracks('lofi beats', { limit: 10, offset: 10 });
}

// Resolve the reference cards an app renders, in one cancellable public-only
// batch. Persist only show ids; the cards are current facts, not cache content.
const cards = await syra.getPublicPodcastCards(['show-1', 'show-2'], {
  signal: AbortSignal.timeout(8000),
});
// cards.items: active PUBLIC shows; cards.unavailableIds: everything else.

// Fetch a single track
const track = await syra.getTrack(page.items[0].id);

// Build a public 30s preview URL (directly playable MP3)
const url = syra.previewUrl(track.id);          // .../api/preview/<id>.mp3?start=0
const hook = syra.previewUrl(track.id, 45);     // start 45s in

// Resolve artwork to an absolute URL
const cover = syra.artworkUrl(track, 'large');
```

## Options

```ts
createSyraClient({
  baseURL: 'https://api.syra.fm', // override the API origin
  fetch,                          // inject a fetch implementation (e.g. node-fetch)
});
```

`fetch` defaults to the global `fetch`. External clients can continue supplying
`getAccessToken` for their existing bounded credentials.

Own product frontends use the existing Oxy session directly with `@oxy.so/core`
7 or newer within major 7 (`@oxy.so/services` 13 supplies that client). The
factory needs the linked client's `fetch` transport, which core 6 does not expose:

```ts
import { syraForOxySession } from '@syra.fm/sdk/client';

const syra = syraForOxySession(oxyServices);
const shows = await syra.listMyPodcasts();
syra.dispose(); // does not dispose the shared Oxy session
```

The linked transport requires Oxy core 7 and follows account switches, renewal
and revocation without copying a bearer into app state. It refuses redirects
and cannot be mixed with `getAccessToken` or a raw `fetch` override. The helper
is structural and adds no Oxy, React or native runtime dependency to the
headless entry. Ticket-authorized episode ingest and signed storage uploads
retain their own credential and never attach the person's session as a second
credential. See [the rollout record](../../docs/first-party-sdk.md).

## API

| Method | Description |
| --- | --- |
| `searchTracks(query, { limit, offset })` | A `SearchPage<TrackSummary>` of preview-available tracks (`{ items, hasMore, limit, offset }`). |
| `getTrack(id)` | A single `TrackSummary`, schema-validated. |
| `previewUrl(id, startSec = 0)` | Public 30s preview URL. |
| `artworkUrl(trackOrCoverArt, size?)` | Absolute artwork URL, or `undefined`. |
| `searchPodcasts(query, { limit, offset })` | A `SearchPage<PodcastSummary>` of podcast shows. |
| `getPodcast(id)` | A single `PodcastSummary`, schema-validated. |
| `getPublicPodcastCards(ids, { signal })` | `{ items, unavailableIds }` for 1–100 distinct show ids: cards (`id`, `title`, `author?`, `artworkUrl?`, `showUrl`) for active public shows; private, unlisted, withdrawn and missing ids in `unavailableIds`. Never sends a token. |
| `podcastUrl(id)` | Syra web deep link (`/podcasts/:id`). |
| `podcastArtworkUrl(show, size?)` | Absolute show-artwork URL, or `undefined`. |
| `subscribeToPodcast(id)` | Subscribe the signed-in caller to a show (idempotent). Needs `getAccessToken`. |
| `unsubscribeFromPodcast(id)` | Unsubscribe the caller (idempotent). Needs `getAccessToken`. |
| `listPodcastSubscriptions()` | The caller's subscribed shows as `{ podcast, lastEpisodeAt? }[]`. Needs `getAccessToken`. |

`hasMore` reflects the backend's pagination over the full result set, so it is
not affected by the client-side preview filter on `searchTracks` — paginate by
advancing `offset` by `limit`, never by `items.length`.

Responses are checked at runtime against the package's own self-contained
types, so there are no shared internal dependencies. A single-object method
throws `SyraApiError` (with a `status`) on a non-2xx response and
`SyraResponseError` (with the `method` and the failing field's `path`) on a 2xx
response that does not have its shape; a list method drops a malformed row and
keeps the rest. Fields the type does not name are dropped.

## Schemas (server-side)

The same response contract as [Zod](https://zod.dev) schemas — for a server
that wants to hold a Syra response to exactly what this SDK accepts:

```ts
import { podcastDeletedSchema, ZRoom } from '@syra.fm/sdk/schemas';
```

It is a separate entry so that an app bundling the client or the live-rooms
engine does not ship Zod (and Zod 4's error locales) for them. A test runs the
schemas and the SDK's own checks over the same fixtures and requires the same
answers.

## Live rooms (React Native)

On React Native and Expo web, the same root export also carries the live-rooms
engine — providers, hooks, components, and icons:

```tsx
import {
  LiveRoomProvider,
  useRoomAudio,
  RoomCard,
  createRoomsService,
  SyraIcon,          // Syra brand mark
} from '@syra.fm/sdk';
```

These require the optional peer dependencies (`react-native`, `livekit-client`,
`@livekit/react-native`, `expo-audio`, `react-native-svg`, …) — present in any
Expo/React Native app, absent from headless Node consumers.

### The client alone in an app

An Expo or React Native app that only needs the API client — no rooms — imports
`@syra.fm/sdk/client`. It is the same client, types and errors as the
root export, under every resolution condition, without the live-rooms engine,
so the app's bundle does not carry LiveKit for it:

```ts
import { createSyraClient } from '@syra.fm/sdk/client';
```

## Changelog

### 0.19.0

- `getPublicPodcastCards(ids, { signal })`: one anonymous `POST
  /api/podcasts/public-cards` for up to 100 show ids. Every id comes back once,
  as a card or in `unavailableIds`; a batch that does not account for each id
  throws `SyraResponseError`. The wire contract (Zod and OpenAPI) is
  [`@syra.fm/contracts`](https://www.npmjs.com/package/@syra.fm/contracts), a
  server-side package — the SDK checks the same shape without Zod. The live
  document is `https://api.syra.fm/api/podcasts/openapi.json`.
- `SyraApiError.code`: the machine-readable `error.code` when a route answers
  with a structured public-API error (`bad_request`, `rate_limited`, …).
- New types: `PublicPodcastCard`, `PublicPodcastCardsResponse`,
  `PublicApiErrorCode`.
- 0.17.0 (dist-tag `confirmed-ecosystem`) was a pre-release of this feature
  that still bundled Zod; use 0.19.0.

### 0.18.0

- **Breaking:** the Zod schemas moved off the root, `./client` and live-rooms
  entries to **`@syra.fm/sdk/schemas`** — `trackSummarySchema`,
  `podcastSummarySchema`, `podcastDeletedSchema`, … and the live-rooms `ZRoom`,
  `ZHouse`, `ZSeries`, `ZRecording`, …. Change the import path; the schemas
  themselves are unchanged.
- The client and the live-rooms engine check responses in plain TypeScript, so
  an app bundling them no longer ships Zod (~240 KiB) and Zod 4's locales
  (~270 KiB). Same verdicts, defaults and key handling as the schemas, held
  together by a parity test.
- A 2xx response that fails its check now throws `SyraResponseError` (exported;
  `method`, `path`) instead of a `ZodError`. Both are `Error`s; `SyraApiError`
  is still the non-2xx error.
- Response types (`TrackSummary`, `Room`, …) are plain interfaces instead of
  `z.infer<…>` aliases, with the same shapes.
