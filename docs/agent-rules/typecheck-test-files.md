# Typecheck after test-only changes

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

Only `bun run typecheck` sees it. Measured in `packages/backend` by introducing
one TS2345 and running all three:

| command | result |
|---------|--------|
| `bun test` | **passes** — bun strips types, it never checks them |
| `bun run build` | **passes** — `tsconfig.build.json` excludes `**/*.test.ts` and `src/test/**` |
| `bun run typecheck` | **1 error** — `bun check` over the whole project |

So after ANY change to a test file or a test-only helper, run `bun run
typecheck`; a green suite and a green build together still prove nothing about
whether it compiles. When reporting verification, name the packages typechecked
rather than folding it into "tests pass" — the two are not the same check.
