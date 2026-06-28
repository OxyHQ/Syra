# @syra.fm/sdk

Headless, isomorphic client for the public [Syra](https://syra.fm) API. Runs on
Node 18+, browsers, and React Native — no React, React Native, or DOM
dependencies; the only runtime dependency is [`zod`](https://zod.dev).
**Public reads only** (no authentication in this version).

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

`fetch` defaults to the global `fetch`. It is the seam through which an
authenticated transport can be layered in a future version.

## API

| Method | Description |
| --- | --- |
| `searchTracks(query, { limit, offset })` | A `SearchPage<TrackSummary>` of preview-available tracks (`{ items, hasMore, limit, offset }`). |
| `getTrack(id)` | A single `TrackSummary`, schema-validated. |
| `previewUrl(id, startSec = 0)` | Public 30s preview URL. |
| `artworkUrl(trackOrCoverArt, size?)` | Absolute artwork URL, or `undefined`. |
| `searchPodcasts(query, { limit, offset })` | A `SearchPage<PodcastSummary>` of podcast shows. |
| `getPodcast(id)` | A single `PodcastSummary`, schema-validated. |
| `podcastUrl(id)` | Syra web deep link (`/podcasts/:id`). |
| `podcastArtworkUrl(show, size?)` | Absolute show-artwork URL, or `undefined`. |

`hasMore` reflects the backend's pagination over the full result set, so it is
not affected by the client-side preview filter on `searchTracks` — paginate by
advancing `offset` by `limit`, never by `items.length`.

Responses are validated at runtime with the package's own self-contained Zod
schemas (`trackSummarySchema`), so there are no shared internal dependencies.
`SyraApiError` (with a `status`) is thrown on non-2xx responses.
