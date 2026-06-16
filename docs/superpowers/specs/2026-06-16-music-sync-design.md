# Syra Music Core — sources, streaming & multi-device (design)

Date: 2026-06-16
Status: Approved (brainstorming) — pending implementation plan

## Product strategy (decided)

Syra is **artist-first**: own platform, own music. **No commercial-label catalog and no
Spotify/YouTube Music integration** (dropped — chicken-and-egg: no users/revenue → can't
afford label deals; and we don't want their metadata-only baggage). The only "outside"
music is what Audius legally allows.

### Catalog sources & where audio lives

| Source | Audio lives | Playback | Notes |
|--------|-------------|----------|-------|
| **Artist uploads** (core) | **Syra S3** | playable | Artist uploads directly, grants Syra a license via ToS. Syra already has `Artist`, `artist/register|upload|dashboard|insights`, S3, copyright reporting. |
| **CC imports (commercial-use only)** | **Syra S3** | playable | Import + self-host ONLY tracks under a Creative Commons license that permits commercial use (filter out CC-NC). Sources: Jamendo, Free Music Archive, ccMixter. |
| **Audius (All-Rights-Reserved)** | Audius network | playable via stream | **Stream only** via Audius `GET /v1/tracks/{id}/stream` (+ `app_name`). The Audius Open Music License **forbids redistribution/rehosting** — never copy these to S3. Gated tracks need a user wallet signature → skip. |

To the user, **everything plays uniformly via streaming** (Spotify-like). The source only
changes the URL behind a unified resolver.

## Legal posture (decided)

- **Artist uploads:** uploader declares ownership/license, grants Syra a license + indemnifies (ToS).
- **EU Article 17 startup exemption** applies while Syra is <3 years old, <€10M annual
  turnover, <5M monthly unique EU visitors: light obligations — best efforts to obtain
  authorization + expeditious **notice-and-takedown**. No Content-ID/stay-down yet.
- **US DMCA safe harbor:** clear ToS, working takedown (`CopyrightReport` +
  `copyright/report.tsx`), **repeat-infringer termination** (formalize on `strikeService`),
  registered DMCA agent, no inducement.
- **Audius:** stream only; never rehost ARR. CC imports only when the CC license permits
  commercial use.
- Optional later: ACRCloud fingerprinting to flag commercial uploads pre-publish.

## Streaming (decided: HLS adaptive, AES-128 encrypted, Spotify-like)

### Ingest / transcode pipeline (owned audio: uploads + CC imports)
- On upload/import: transcode to **AAC 96 / 160 / 320 kbps**, package as **HLS**
  (`.m4a` segments + multivariant `.m3u8`), **AES-128 encrypt** (`#EXT-X-KEY`) via Shaka
  Packager / Bento4. ffmpeg (audio — no GPU).
- **Loudness normalization** (EBU R128 / ReplayGain) at transcode (Spotify's "normalize volume").
- Store renditions in `oxy-syra-media-usw2-237343248947`; serve via **CloudFront** with
  **signed URLs/cookies** that expire.
- Async job per upload/import; track `status` (`processing` | `ready` | `failed`).

### Unified stream resolver (3 sources, 1 player)
`GET /api/stream/:trackId` → `{ url, type: 'hls' | 'audius', expiresAt }` based on
`track.source`: owned/CC → signed **encrypted HLS** manifest (CDN); Audius → Audius stream
URL (or light backend proxy for unified auth/analytics).
`GET /api/stream/:trackId/key` → AES-128 key, **authenticated, short-TTL**, bound to session.

### Players
- Native: **`expo-audio`** (present) — AVPlayer/ExoPlayer support HLS + AES-128 + background + lockscreen.
- Web: **`expo-audio` is universal**, but its web `<audio>` can't play HLS on Chrome/Firefox →
  tiny **web-only shim** feeds HLS + AES key via **`hls.js`** (`Hls.isSupported()` → hls.js;
  else native HLS for Safari). Only the source-attach leaf forks (`.web.ts`/`.native.ts`);
  store/queue/Connect/UI shared.
- Quality selector wired to existing `AudioQuality` setting (normal/high/very_high).
- **Real DRM (Widevine/FairPlay)** deferred (would need react-native-video + Shaka + license
  server + Apple/Google enrollment) — only if a licensed commercial catalog is added later.
- **Offline:** encrypted local cache — later, premium.

## Multi-device control (decided: full Spotify Connect-style, control + transfer)

**Control plane, not audio relay.** Each device pulls its own stream from the CDN/Audius;
devices exchange commands + state, not audio.

- **`Device`** model: `{ userId, name, type, capabilities, lastSeen, isActive }`.
- **`PlaybackState`** model: ONE per user, **server-authoritative**:
  `{ trackId, source, positionMs, isPlaying, queue[], context, repeat, shuffle, volume,
  activeDeviceId, updatedAt }`.
- Transport: extend existing **`playerSocket`**. Events: `device:register`, `device:list`,
  `playback:state`, `playback:command` (play/pause/seek/next/prev/**transfer**/volume/
  shuffle/repeat), `playback:progress`, heartbeat.
- Active device plays audio; others are remote controls. Transfer moves `activeDeviceId` +
  position; old device stops.
- **Casting (Chromecast/AirPlay)** = real audio to speaker/TV → later phase.

## Canonical catalog (one professional, provider-agnostic collection)

Single catalog any source upserts into, deduped by ISRC, provenance preserved.

- Extend `Track`/`Artist`/`Album`: `externalIds { isrc?, audiusId? }`, `sources[]`
  (provenance), `source` (`upload` | `cc` | `audius`), `status` (`processing` | `ready` |
  `failed`), `images[]`, `hls[]` renditions, `loudnessLufs`, `streamUrl?` (audius).
  `audioSource` becomes optional (audius/processing tracks have none).
- New collections: `Lyrics` (LRCLIB via abstracted `LyricsProvider`), `ImportJob`
  (Audius/CC ingestion progress), `Device`, `PlaybackState`.
- Dedup/upsert by ISRC → fuzzy (normalized title + primary artist + duration ±2s) in
  `upsertTrack` so re-imports don't duplicate.

### Artists & ownership (store photos + info; structure it well)
- **Own artists (uploads):** store everything — name, bio, `image` (own S3 ObjectId),
  genres, links, country, verified, colors, `ownerOxyUserId`, `stats`. Fully owned.
- **External artists (Audius/CC):** store the metadata the license permits — name +
  `images[]` (referenced external URLs) + `externalIds.audiusId` + attribution. Don't claim
  ownership.
- Extend `Artist`: add `source` (`upload`|`cc`|`audius`), `externalIds`, `sources[]`,
  `images[]` (external), `links` (website/socials), `country`, `claimable` +
  `claimedByOxyUserId` (an imported artist a real artist can later **claim**).
- **FIX (latent bug):** `Artist.name` is currently `unique: true` — breaks multi-source
  (same name across sources collides). Drop the unique constraint; dedup by `externalIds`
  (+ owner) in an `upsertArtist` helper. Same for `Album`.

## User preferences & premium gating

Most playback prefs already exist in `UserMusicPreferences` (`normalizeVolume`,
`defaultVolume`, `crossfade`, `gaplessPlayback`, `autoplay`, `explicitContent`) — wire them
to the player (currently not applied). Add:
- `audioQuality` (streaming): `low | normal | high | very_high` — **high/very_high gated to
  premium**.
- `downloadQuality` (offline, future, premium), `dataSaver`, `monoAudio`.

**Premium source (decided):** gate on the existing `user.premium.isPremium` (from Oxy;
currently mock — real billing wiring is a separate dependency). Use an `isPremium(user)`
helper so the source can change later.

**Gating enforced server-side, not just UI (critical):** the stream resolver
(`/api/stream/:trackId`) **caps the served HLS variant** by the user's entitlement — a Free
user never receives the 320 kbps manifest even if the client is tampered. UI shows
locked rows + upsell; the resolver enforces.

**Settings UI (`settings.tsx`, extend):** audio quality 🔒, download quality 🔒, data saver,
normalize volume, crossfade, gapless, autoplay, mono audio, explicit content. Locked premium
rows show a lock + upgrade CTA.

## Lyrics
- Via **LRCLIB** behind a `LyricsProvider` interface (LRCLIB unlicensed → abstracted so a
  licensed source like Musixmatch is a config swap later). Cached in `Lyrics`.

## Sources connectors
`MusicSourceConnector` interface. Implementations:
- `AudiusConnector` — search/browse + import metadata; resolver returns Audius stream;
  **never rehost ARR**.
- `CcConnector` — Jamendo / FMA / ccMixter; **filter CC licenses that permit commercial
  use** (reject CC-NC); enqueue transcode-to-S3 via `ImportJob`.

## Frontend
- Audius **search/browse** screen → play + add to library.
- CC import = backend/admin ingestion (`ImportJob`); optional admin UI.
- Player + Connect UI: device picker, transfer, remote control on `PlayerBar`.
- Lyrics view in the player.

## Risks / constraints
- HLS transcode cost/latency — async job per upload/import.
- CloudFront signed-URL key management (key pair in SSM).
- AES-128 key endpoint must be authenticated + short-TTL (light DRM, not studio-grade).
- Audius gated tracks unplayable without wallet — skip.
- Lyrics licensing — abstracted.

## Out of scope (now)
- **Spotify / YouTube Music sync — dropped** (no commercial music).
- Commercial-label catalog (7digital/Feed.fm) — revisit with traction.
- Chromecast/AirPlay casting; offline downloads; real DRM (Widevine/FairPlay).
- Rehosting Audius All-Rights-Reserved content (illegal — never).
