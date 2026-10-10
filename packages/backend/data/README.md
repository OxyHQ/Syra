# `podcast-feeds.txt` — the input the podcast catalogue is rebuilt from

Podcasts are a MIRROR of external RSS, and `importFeed`
(`src/services/podcasts/podcastImportService.ts`) says so — *"Fetch a feed and
mirror it into the catalog. Idempotent: re-running upserts the same
show/episodes."* Given the feed URLs, the entire podcast catalogue (shows,
episodes and their derived image assets) rebuilds itself.

**So the feed URLs are the irreplaceable input, and they are 68 KB.** This file is
them: 1,358 unique feed URLs. Re-import drives them through the same path the app
uses (`src/scripts/reimportPodcastFeeds.ts`, `POST /api/podcasts/import`, or
`importFeed` directly), which is idempotent, so running it twice is safe and
resuming a half-finished run needs no bookkeeping.

`uploaded-tracks.json` is the other input here: the creator-uploaded track rows
`src/scripts/restoreUploadedTracks.ts` writes back. Uploads cannot rebuild
themselves the way RSS can — nobody but the creator has the original.
