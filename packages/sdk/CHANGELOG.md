# Changelog

## 0.27.0

Breaking (the 0.x breaking bump): the live-rooms UI no longer uses NativeWind,
so an app on Bloom 23, which drops NativeWind, draws it unchanged.

- The components style with React Native styles over Bloom's colour tokens
  (`createTokenStyles` from `@oxy.so/bloom/theme`) instead of `className`. The
  look is the same: each converted element was rendered before and after, light
  and dark, native and web, and compared.
- New optional peer `@oxy.so/bloom` `>=23.0.0` (the live-rooms entry needs it;
  the headless client does not).
- `LiveConfig.dockClassName` is removed. A host whose web shell scrolls the
  document passes `documentScroll: true` (it was `dockClassName: 'web:fixed'`):
  the dock and its backdrop pin to the viewport with `position: fixed` on the
  web, and nothing changes on native.
- `@oxy.so/services` 15 is admitted (`>=13.0.0 <16.0.0`).
- The `nativewind` dev dependency and its `nativewind/types` reference are gone.

## 0.26.0

Breaking: the external episode lane is removed. Syra now writes and voices
podcast episodes itself (`POST /api/podcasts/:id/episodes/generate`, and the
`generate-episode` tool of its MCP server at `api.syra.fm/mcp`), so the API
endpoints these methods called are gone.

- Removed `createEpisodeDraft`, `ingestEpisode` and `abandonEpisodeIngest`, and
  the types `EpisodeDraft`, `CreateEpisodeDraftInput` and `IngestEpisodeInput`
  (and `episodeDraftSchema` from `@syra.fm/sdk/schemas`). The server routes
  `POST /api/podcasts/:id/episodes/draft` and `POST
  /api/podcasts/episodes/:id/ingest` (with `/ingest/upload` and
  `/ingest/abandon`) no longer exist.
- Removed `aliaSeriesId` from `CreatePodcastInput`, and `imageFileId` from
  `CreatePodcastInput` and `UpdatePodcastInput`: a cover is an image id from
  `uploadPodcastImage`.
- Removed `audioMimeType` from `@syra.fm/sdk/upload`, and `payloadBlob` is no
  longer exported from it; `sendAudioUpload` is unchanged.
