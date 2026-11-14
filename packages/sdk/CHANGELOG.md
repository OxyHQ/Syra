# Changelog

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
