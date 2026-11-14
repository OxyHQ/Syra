# Syra

Syra is a music streaming platform (syra.fm): a Bun monorepo with an Expo frontend, an Express/Drizzle API, a creator studio and a public SDK.

## Commands

Run from the repo root with Bun (pinned in `package.json` `packageManager`).

```bash
bun install                      # setup; postinstall builds contracts + shared-types
bun run dev:backend              # API (local port 4120); also dev:frontend, dev:studio
bun run test                     # every workspace; one package: bun run --filter '@syra/backend' test
bun run typecheck                # not a root script: run per package, e.g. bun run --cwd packages/backend typecheck
bun run lint                     # Biome + expo lint; lint:fix / format write
bun run build                    # every workspace; build:backend, build:frontend, build:studio, build:sdk
bun run validate:agents-md       # AGENTS.md size budget (CI: Quality)
```

## Map

- `packages/`: `frontend` (Expo, syra.fm), `backend` (Express API, api.syra.fm), `studio` (creator portal), `sdk` (`@syra.fm/sdk`), `shared-types`, `contracts`.
- Docs index: [docs/README.md](docs/README.md). Rules that used to live here: [docs/agent-rules/](docs/agent-rules/).
- Generated episodes and the public MCP server (`api.syra.fm/mcp`): [podcast-generation](docs/podcast-generation.md), [mcp](docs/mcp.md); inference only through `@kaana.ai/sdk` ([ai-routing](docs/ai-routing.md)).
- Inter-product calls and cutover status: [docs/architecture/first-party-platform.md](docs/architecture/first-party-platform.md), [docs/first-party-sdk.md](docs/first-party-sdk.md).
- Runbooks: [docs/runbooks/](docs/runbooks/).

## Conventions that differ from defaults

- Every catalog or playback read goes through `playableTrackFilter()` (`packages/backend/src/db/catalog/visibility.ts`); `isTrackPlayable` and `isPlayableTrack` change with it, so a takedown cannot stay listed but fail at play. [catalog-and-playback](docs/agent-rules/catalog-and-playback.md).
- Compose catalog filters with drizzle `and(...)`, never by spreading filter objects: spreading drops an earlier `or`.
- Keep a field out of a response only through `PROTECTED_COLUMNS_BY_TABLE` (`db/schema/protectedColumns.ts`); prefer DTOs that name every key. [server-only-fields](docs/agent-rules/server-only-fields.md).
- A new zod DTO field gets its storage in the same change: `zodPathsExistInDrizzle.test.ts` fails otherwise, and `tsc` cannot see it. [zod-dto-storage](docs/agent-rules/zod-dto-storage.md).
- Every image is an Oxy file (`image_assets.oxy_file_id`); audio goes only through `services/oxyFiles/audioStorage.ts`; no audio body goes to `api.syra.fm` (100 MB proxy limit). [oxy-files](docs/agent-rules/oxy-files.md).
- Server state is TanStack Query, API boundaries are Zod, Zustand holds local-only state; do not mirror remote data in Zustand. [frontend-state](docs/agent-rules/frontend-state.md).
- Own service calls use the shared workload provider: no internal scopes or client keys. Gate private API calls with `useAuth().canUsePrivateApi`. [oxy-integration](docs/agent-rules/oxy-integration.md).
- Reviewer access (`compliance.review`) comes from the owning Oxy org role; keep `packages/backend/src/config/applicationPermissions.ts` equal to the oxy registry ([application roles](https://github.com/OxyHQ/oxy/blob/main/docs/auth/application-roles.md)).
- Biome formats and lints (`bunx biome ci .`); the sonner ban and `EXPO_PUBLIC_*` rules are lint gates ([local notes](docs/agent-rules/lint-and-format.md), [lint and format](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md)).
- Runtime is Bun, including one-shot commands (`deployWorkflow.test.ts`). Production hosts are `syra.fm` and `api.syra.fm`. [deploy](docs/agent-rules/deploy.md).

## Boundaries

Never:
- Publish to npm from a laptop: merging a version bump publishes it ([npm releases](https://github.com/OxyHQ/oxy/blob/main/docs/npm-releases.md)).
- Add retired Syra `oxy.so` hosts to runtime config, CORS, EAS env, universal links or deploy scripts.
- Write SSM from a workflow or put secrets in GitHub: SSM `/oxy/syra/*` is the only source.
- Add an external music ingest path: music enters only by creator upload.

Ask first:
- Changing `deploy-aws.yml` or `.github/CODEOWNERS` files: they decide what production runs.
- Hiding `catalog_entities` `imageLicence*` columns: they are public on purpose (CC BY-SA attribution).

## Testing

- Backend, sdk and shared-types use `bun test`; frontend and studio use Jest.
- After any test-file or test-helper change, also run the package `typecheck`: `bun test` and the build both ignore type errors in tests ([details](docs/agent-rules/typecheck-test-files.md)).
- Done means: touched packages tested and typechecked (name them when reporting), `bun run lint` clean, `bun run validate:agents-md` passing.

## PR and commit rules

- Branch from `main`, open a PR to `main`; CI (Quality) must pass before merge.
- Org-wide TypeScript, React, naming, security and git standards: [OxyHQ/engineering](https://github.com/OxyHQ/engineering/blob/main/AGENTS.md); Oxy-wide traps: [build and runtime traps](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md), [gate writing](https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md).

## Secrets

Secrets come from SSM `/oxy/syra/*` (SecureString); set or rotate with `aws ssm put-parameter --overwrite` ([infra and deploys](https://github.com/OxyHQ/oxy-infra/blob/main/docs/infra-and-deploys.md), private). Never print `*_DATABASE_URL` or token values.

Owner: OxyHQ (CODEOWNERS @NateIsern). Last reviewed: 2026-11-11.
