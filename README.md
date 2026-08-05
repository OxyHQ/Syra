<p align="center">
  <b>Syra is a music and podcast platform for iOS, Android and the web.</b><br>
  Artists upload their own work, listeners stream it, and live audio rooms run on top of the same catalogue.
</p>

<p align="center">
  <a href="https://syra.fm"><img alt="syra.fm" src="https://img.shields.io/badge/syra.fm-440151?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@syra.fm/sdk"><img alt="npm" src="https://img.shields.io/npm/v/@syra.fm/sdk?style=flat-square&color=440151&label=%40syra.fm%2Fsdk"></a>
  <a href="./LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-informational?style=flat-square"></a>
  <img alt="Expo SDK 57" src="https://img.shields.io/badge/Expo-SDK%2057-000020?style=flat-square&logo=expo&logoColor=white">
  <img alt="React Native 0.86" src="https://img.shields.io/badge/React%20Native-0.86-61DAFB?style=flat-square&logo=react&logoColor=black">
  <img alt="TypeScript 5.9" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-000000?style=flat-square&logo=bun&logoColor=white">
</p>

---

<table>
<tr>
<td valign="top" width="50%">

### What Syra is

An own catalogue platform. Every track is Syra hosted, and music enters through exactly one path: a creator uploads it, the backend transcodes it to HLS, and it becomes playable. There is no external ingest, no import service and no provider reconciliation.

That single path is what makes the rules simple. A track is playable if it is available and has not been removed for copyright, one predicate that both the catalogue and the player ask, so a takedown can never stay listed and then fail at play.

Podcasts are a separate vertical and do mirror external RSS.

</td>
<td valign="top" width="50%">

### How it fits the Oxy platform

Identity and sessions come from [**oxy**](https://github.com/OxyHQ/oxy). Both apps mount one `OxyProvider` from `@oxyhq/services`, and every authenticated call goes through a single linked client built with `@oxyhq/core`, never a per screen token header. The interface is [**Bloom**](https://github.com/OxyHQ/Bloom).

Syra also gives something back to the ecosystem. `@syra.fm/sdk` ships the live rooms engine that powers audio rooms in [**Mention**](https://github.com/OxyHQ/Mention), and a headless catalogue client anyone can read the public API with.

</td>
</tr>
</table>

## Workspaces

| Package | Path | What it holds |
|---|---|---|
| `@syra/frontend` | [`packages/frontend`](./packages/frontend) | The listener app for iOS, Android and web: browse, search, library, playlists, albums, artists, podcasts, radio, live rooms and upload |
| `@syra/backend` | [`packages/backend`](./packages/backend) | Express 5 API and Socket.IO: catalogue, ingest and HLS transcoding, streaming entitlement, recommendations, copyright handling |
| `@syra/studio` | [`packages/studio`](./packages/studio) | The creator portal: register and upload music, run insights, manage podcast shows and episodes, go live |
| [`@syra.fm/sdk`](https://www.npmjs.com/package/@syra.fm/sdk) | [`packages/sdk`](./packages/sdk) | The public SDK: a headless catalogue client plus the live rooms engine |
| `@syra/shared-types` | [`packages/shared-types`](./packages/shared-types) | The TypeScript DTOs the frontend, studio and backend all compile against |

## Quick start

You need [Bun](https://bun.sh) 1.3 or newer, Node.js 18 or newer, and a MongoDB instance.

```bash
bun install         # also builds shared-types via postinstall
bun run dev         # every workspace
```

Or start one at a time:

```bash
bun run dev:frontend
bun run dev:studio
bun run dev:backend
```

The frontend and studio are Expo apps. Run a specific target from their workspace:

```bash
bun run --cwd packages/frontend web
bun run --cwd packages/frontend ios
bun run --cwd packages/frontend android
```

<details>
<summary><b>Builds, tests and lint</b></summary>

<br>

```bash
bun run build                # every package
bun run build:shared-types
bun run build:sdk
bun run build:frontend
bun run build:studio
bun run build:backend
bun run test                 # every package
bun run lint                 # every package
bun run clean
```

The backend also carries operational scripts, run from its own workspace: `ensure-indexes`, `seed:music`, `migrate:catalog-entities`, `backfill:fingerprints` and `reseed:persons`.

</details>

## Using the SDK

`@syra.fm/sdk` is one flat package that resolves per platform through export conditions, so a Node consumer never installs React Native or LiveKit.

```bash
bun add @syra.fm/sdk
```

```ts
import { createSyraClient } from '@syra.fm/sdk';

const syra = createSyraClient(); // defaults to https://api.syra.fm

const page = await syra.searchTracks('lofi beats', { limit: 10 });
const track = await syra.getTrack(page.items[0].id);

const preview = syra.previewUrl(track.id);        // a directly playable 30 second MP3
const cover = syra.artworkUrl(track, 'large');
```

On Node and in bundlers you get the headless catalogue client: public reads only, no React, no DOM, with `zod` as the single runtime dependency. On React Native through Metro and on Expo web you additionally get the live rooms engine, audio rooms over LiveKit, and the `SyraIcon` brand mark. Its React Native, LiveKit and Expo dependencies are optional peers, so headless consumers never pull them in.

Full reference in the [SDK README](./packages/sdk/README.md).

## Architecture notes

<table>
<tr>
<td valign="top" width="50%">

**State ownership in the apps**

TanStack Query owns server state: catalogue reads, library, playlists, artist profiles, preferences, recommendations and privacy. Zod validates responses at the service boundary. Zustand is reserved for local state only, player, queue and transient UI, and never mirrors data Query already owns.

Identity sensitive queries wait for the Oxy cold boot to settle and keep separate cache keys for guest and signed in, so an anonymous startup response can never leak into a session.

</td>
<td valign="top" width="50%">

**The backend is the authority**

Playback resolves through the stream resolver on the backend, which is the sole entitlement authority. Frontend preference state is never the source of truth for whether something may play.

Containers follow the tracks. An album, artist, playlist, genre card or search result is not presented as playable when it holds no playable tracks, because the alternative is a listener tapping into an empty room.

</td>
</tr>
</table>

## Documentation

| Document | Covers |
|---|---|
| [Documentation index](./docs/README.md) | Everything below, in one place |
| [Theme quick reference](./docs/THEME_QUICK_REFERENCE.md) | Theming with Bloom and NativeWind |
| [Theming troubleshooting](./docs/THEMING_TROUBLESHOOTING.md) | Common theming failures and their causes |
| [Performance guide](./docs/PERFORMANCE_GUIDE.md) | Where the time goes and how to get it back |
| [Runbooks](./docs/runbooks) | Ordered production steps, including the user upload rollout |
| [Compliance](./docs/compliance) | DMCA policy and the repeat infringer clause |
| [Backend README](./packages/backend/README.md) | The API surface in detail |
| [Frontend README](./packages/frontend/README.md) | The app in detail |

Instructions for AI coding agents live in [`AGENTS.md`](./AGENTS.md).

## Contributing

Contributions are welcome, especially from people who make music and can tell us where the product gets an artist's needs wrong. Open an issue or a pull request, and run `bun run test && bun run lint` before you do. Org wide [contributing notes](https://github.com/OxyHQ/.github/blob/main/CONTRIBUTING.md), the [security policy](https://github.com/OxyHQ/.github/blob/main/SECURITY.md) and the [code of conduct](https://github.com/OxyHQ/.github/blob/main/CODE_OF_CONDUCT.md) live in the organisation profile.

## License

MIT. See [LICENSE](./LICENSE).
