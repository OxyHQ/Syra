# Syra Music Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Syra's music core — one canonical catalog fed by artist uploads + commercial-use CC imports + Audius, with real adaptive (HLS, AES-128 encrypted) streaming and Spotify Connect-style multi-device control. **No Spotify/YouTube Music, no commercial-label catalog.**

**Architecture:** Canonical Track/Artist/Album gain `externalIds`/`sources`/`source`/`status`/`images`/`hls`. Owned audio (uploads + commercial-use CC) is transcoded to AES-128-encrypted HLS in S3, served via CloudFront signed URLs; Audius tracks stream from the Audius network (never rehosted). A unified resolver hands the player one URL per source. Playback is server-authoritative (`PlaybackState` + `Device`) over the existing `playerSocket` for cross-device control + transfer.

**Tech Stack:** Bun, Express + Mongoose, Expo/expo-router, `expo-audio` (+ `hls.js` web shim), `@tanstack/react-query`, Bloom, `@syra/shared-types`, ffmpeg + Shaka Packager/Bento4 (transcode/encrypt), CloudFront (CDN), Audius API, LRCLIB.

**Spec:** `docs/superpowers/specs/2026-06-16-music-sync-design.md`

---

## Program phasing (each phase = an independently shippable, testable slice)

Phase 1 is detailed below (full TDD). Phases 2+ are concrete outlines (files,
responsibilities, key interfaces, test strategy) — **each expanded just-in-time into full
TDD steps right before it is executed**, following the Phase 1 shape and the spec.

1. **Catalog foundation** — shared-types + Track/Artist/Album schema (`externalIds`,
   `sources`, `source`, `status`, `images`, `hls`, `loudnessLufs`, `streamUrl`;
   `audioSource` optional) + `upsertTrack` dedup/provenance (ISRC → fuzzy). _Detailed below._
2. **Ingest → encrypted-HLS pipeline** — on upload/import: ffmpeg transcode AAC 96/160/320,
   EBU R128 loudness normalization, package HLS, **AES-128 encrypt** (Shaka Packager/Bento4),
   store renditions in `oxy-syra-media-usw2`; set `Track.status`. Async job. Tests: pipeline
   on a sample file → asserts manifests + encrypted segments + key artifact + status flip.
3. **Delivery + unified resolver** — CloudFront signed URLs/cookies (key pair in SSM);
   `GET /api/stream/:trackId` → `{ url, type, expiresAt }` (owned→signed HLS, audius→Audius
   stream/proxy); `GET /api/stream/:trackId/key` (authenticated, short-TTL AES key). Tests:
   resolver per source; key endpoint authz + TTL.
4. **Player layer** — shared `playerStore`/`queueStore` (exist) + `attachSource`
   `.native.ts` (expo-audio) / `.web.ts` (Safari→expo-audio, else hls.js + AES key cb); wire
   `AudioQuality`. Tests: source resolution + quality selection (mock player).
5. **User preferences + premium gating** — extend `UserMusicPreferences` (`audioQuality`,
   `downloadQuality`, `dataSaver`, `monoAudio`); `isPremium(user)` helper gating on
   `user.premium.isPremium` (Oxy; mock for now); **server-side variant cap in the resolver**
   (a Free user never receives high/very_high HLS); wire existing prefs (normalize/crossfade/
   gapless/autoplay/explicit) to the player; extend `settings.tsx` with locked premium rows +
   upsell. Tests: resolver caps variant by entitlement; pref persistence; locked-row logic.
6. **Multi-device (Connect)** — `Device` + server-authoritative `PlaybackState` models;
   extend `playerSocket` with `device:register|list`, `playback:state|command|progress`,
   heartbeat; transfer. Device-picker UI on `PlayerBar`. Tests: command→state→broadcast;
   transfer moves activeDevice+position; offline failover.
7. **Sources connectors** — `MusicSourceConnector` interface; `AudiusConnector` (search/import
   metadata, resolver returns Audius stream, **never rehost ARR**); `CcConnector`
   (Jamendo/FMA/ccMixter — **filter CC licenses that permit commercial use**, reject CC-NC →
   enqueue transcode-to-S3); `ImportJob` model + progress. Tests: license filter; Audius
   normalization (mock HTTP); import job counts.
8. **Lyrics** — `LyricsProvider`/`LrclibProvider` + `Lyrics` model + cache + `GET /lyrics/:trackId`.
   Tests: parser (synced LRC + plain); cache hit/miss.
9. **Frontend** — Audius search/browse → play + add to library; player + Connect device UI;
   lyrics view; optional admin CC-import UI. Tests: services + components.
10. **Compliance** — formalize repeat-infringer policy on `strikeService`; ToS clause; DMCA
   agent registration (doc/runbook); ACRCloud fingerprint hook (stub for future). Tests:
   repeat-infringer termination logic.

**Credential prerequisite (Nate):**
- Phase 3: CloudFront key pair → SSM `/oxy/syra/CF_SIGNING_KEY_ID` + private key.
- (No OAuth / Spotify / Google credentials needed — those sources were dropped.)

---

## Phase 1 — Catalog foundation

**File structure:**
- Modify: `packages/shared-types/src/track.ts` — add `CatalogSource`, `TrackStatus`,
  `ExternalIds`, `SourceProvenance`, `TrackImage`, `HlsRendition`; extend `Track`.
- Modify: `packages/shared-types/src/artist.ts`, `album.ts` — add `externalIds`, `sources`.
- Create: `packages/shared-types/src/integrations.ts` — `ExternalTrack`/`ExternalArtist`/`ExternalAlbum`.
- Modify: `packages/shared-types/src/index.ts` — export new module.
- Modify: `packages/backend/src/models/Track.ts` — schema for new fields; `audioSource` optional;
  `status` default `'ready'`; sparse indexes on external ids.
- Modify: `packages/backend/src/models/Artist.ts`, `Album.ts` — new fields.
- Create: `packages/backend/src/services/catalog/upsertTrack.ts` — idempotent upsert/dedup by
  ISRC/externalId with provenance merge.
- Test: `packages/backend/src/services/catalog/upsertTrack.test.ts`.

### Task 1.1: Add shared types

- [ ] **Step 1: Add types to `packages/shared-types/src/track.ts`**

```ts
export type CatalogSource = 'upload' | 'cc' | 'audius';
export type TrackStatus = 'processing' | 'ready' | 'failed';

export interface ExternalIds {
  isrc?: string;
  audiusId?: string;
}
export interface SourceProvenance {
  provider: CatalogSource;
  externalId: string;
  importedAt: string;
  fields: string[];
}
export interface TrackImage { url: string; width?: number; height?: number; source?: CatalogSource; }
export interface HlsRendition { manifestKey: string; bitrateKbps: number; encrypted: boolean; }
```

Extend `Track`:

```ts
export interface Track extends Timestamps {
  // ...existing fields...
  audioSource?: AudioSource;        // optional: audius/processing tracks have none
  source: CatalogSource;
  status: TrackStatus;
  externalIds?: ExternalIds;
  sources?: SourceProvenance[];
  images?: TrackImage[];
  hls?: HlsRendition[];
  loudnessLufs?: number;            // EBU R128 measured loudness
  streamUrl?: string;               // audius: direct network stream
}
```

- [ ] **Step 2: Extend `Artist` (`artist.ts`) and `Album` (`album.ts`)**

`Album`: add `externalIds?: ExternalIds; sources?: SourceProvenance[];`

`Artist`: add full multi-source structuring:

```ts
  source: CatalogSource;            // 'upload' | 'cc' | 'audius'
  externalIds?: ExternalIds;        // { audiusId? }
  sources?: SourceProvenance[];
  images?: TrackImage[];            // external image URLs (audius/cc); own uploads use `image`
  links?: { website?: string; instagram?: string; x?: string; youtube?: string };
  country?: string;
  claimable?: boolean;              // imported artist a real artist can claim
  claimedByOxyUserId?: string;
```

- [ ] **Step 3: Create `packages/shared-types/src/integrations.ts`**

```ts
import { CatalogSource, ExternalIds, TrackImage } from './track';

export interface ExternalArtist { name: string; externalId: string; images?: TrackImage[]; }
export interface ExternalAlbum { name: string; externalId: string; images?: TrackImage[]; }
export interface ExternalTrack {
  provider: CatalogSource;           // 'audius' | 'cc'
  externalId: string;
  title: string;
  artists: ExternalArtist[];
  album?: ExternalAlbum;
  durationSec: number;
  isrc?: string;
  images?: TrackImage[];
  streamUrl?: string;                // audius
  downloadUrl?: string;              // cc (commercial-use license only)
  license?: string;                  // cc license id (filter CC-NC out)
}
```

- [ ] **Step 4: Export from `index.ts`** — add `export * from './integrations';`
- [ ] **Step 5: Build** — Run: `bun run build:shared-types`. Expected: exits 0.
- [ ] **Step 6: Commit** — `git add packages/shared-types && git commit -m "feat(types): canonical catalog + external source types"`

### Task 1.2: Extend Mongoose schemas

- [ ] **Step 1: `models/Track.ts`** — `audioSource` optional; add `source` (index),
  `status` (default `'ready'`, index), `externalIds` sub-schema (sparse unique index on
  `externalIds.isrc`, sparse on `audiusId`), `sources[]`, `images[]`, `hls[]`, `loudnessLufs`,
  `streamUrl`.
- [ ] **Step 2: `models/Artist.ts`** — **DROP `unique: true` on `name`** (breaks multi-source);
  add `source` (index), `externalIds` sub-schema (sparse index on `audiusId`), `sources[]`,
  `images[]`, `links`, `country`, `claimable` (index), `claimedByOxyUserId`. Keep existing
  `image` (own S3 ObjectId) + `ownerOxyUserId`. `models/Album.ts` — `externalIds` + `sources`
  sub-schemas, sparse indexes.
- [ ] **Step 3: Backfill** — `packages/backend/src/scripts/backfillCatalogFields.ts` sets
  `status:'ready'`, `source:'upload'` where missing. Run manually post-deploy.
- [ ] **Step 4: Verify** — `artist/upload` controller still sets `source:'upload'` + `status:'ready'` (or `'processing'` once Phase 2 lands) on create. Patch if needed.
- [ ] **Step 5: Typecheck** — Run: `bun run build:backend`. Expected: no new TS errors.
- [ ] **Step 6: Commit** — `git commit -am "feat(models): externalIds/sources/source/status/hls on catalog"`

### Task 1.3: `upsertTrack` dedup helper (TDD)

- [ ] **Step 1: Failing test** `services/catalog/upsertTrack.test.ts` — (a) new ISRC inserts;
  (b) same ISRC re-import updates same doc + appends provenance, no dup; (c) no ISRC → fuzzy
  key (normalized title + primary artist + duration±2s); (d) merge never overwrites non-empty
  with empty; records `sources[].fields`.
- [ ] **Step 2: Run, verify FAIL** — `bun test packages/backend/src/services/catalog/upsertTrack.test.ts` (module missing).
- [ ] **Step 3: Implement** `upsertTrack(external: ExternalTrack, source: CatalogSource): Promise<{ track, created }>` — find by isrc → externalId → fuzzy; merge with provenance; never clobber; set `status` (`'processing'` for cc pending transcode, `'ready'` for audius).
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(catalog): idempotent upsertTrack with ISRC dedup + provenance"`

### Task 1.4: `upsertArtist` dedup helper (TDD)

- [ ] **Step 1: Failing test** `services/catalog/upsertArtist.test.ts` — (a) new external artist
  inserts with `source`; (b) same `externalIds.audiusId` re-import updates same doc, no dup
  (name is NOT unique now); (c) two artists with the same name from different sources do NOT
  collide; (d) provenance appended; (e) own (`ownerOxyUserId`) artist never overwritten by import.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** `upsertArtist(external: ExternalArtist, source: CatalogSource): Promise<{ artist, created }>` — dedup by `externalIds.audiusId` → else create; set `claimable:true` for imported; never clobber owned fields.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(catalog): upsertArtist dedup by externalIds (name no longer unique)"`

---

## Phases 2–10
Outlined above. Each is expanded into full TDD tasks (failing test → run fail → implement →
run pass → commit) immediately before execution, following the Phase 1 shape and the spec.
