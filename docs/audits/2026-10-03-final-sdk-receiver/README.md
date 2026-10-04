# Syra receiver candidate verification

The source is unchanged in production paths. An owned child process configures its
synthetic issuer before importing the actual OxyServer singleton and the canonical middleware mounted by server.ts.
The parent does not mutate the environment or import product configuration. Fetch
rejects non-loopback destinations in the child; this is a fetch guard, not an OS
network namespace. No real credential, grant or provider is involved.

Three HTTP controls pass in one test: missing/sessionless bearer denial; validated
owner and contradictory subject denial; next-call revocation with a fresh issuer
validation. Issuer signature/authority is synthetic, the installed SDK and HTTP
receiver are real. The protected handler is fixture-only; this does not test
product domain SQL or deployment. Historical candidate 1b505 is not published.

Build and whole-backend types pass. Initial TypeScript fixture errors are retained
in candidate/final logs; final2 is the successful command. The package test filter reports 1 PASS, 22 existing skipped tests and 0 FAIL across 156 discovered files. This is not a full-suite acceptance.

Manifest/lock snapshots are evidence only. The worktree manifests remain local
candidate file references and will be replaced with real registry versions before
final adoption. Final registry, frontend and runtime rollout remain pending.
