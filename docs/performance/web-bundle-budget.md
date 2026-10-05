# Web export budgets

The gate measures initial scripts from `dist/index.html`, deferred Bloom translations,
other JavaScript, and non-JavaScript assets independently. Every byte remains charged
to a limited category; no language or asset is excluded from the total.

The former all-JavaScript ceiling conflated the first download with all languages a
user could select. Bloom 6 added fourteen deferred translation chunks. Comparing
Syra main `c029a12` (Bloom 5.1) with the migration showed that initial JavaScript
already decreased while the complete export grew. Measurements use CI's Bun 1.3.14;
Node and Python gzip implementations produce different totals.

| Category | Previous baseline | Optimized Bloom 6.2 | Ceiling |
| --- | ---: | ---: | ---: |
| Initial JavaScript | 8,992,580 | 8,244,839 | 8,992,580 |
| Initial JavaScript gzip | 2,188,949 | 2,052,658 | 2,188,949 |
| Deferred Bloom translations | 0 | 1,028,965 | 1,028,965 |
| Deferred Bloom translations gzip | 0 | 352,616 | 352,616 |
| Other JavaScript | 683,469 | 633,703 | 683,469 |
| Other JavaScript gzip | 205,136 | 203,138 | 205,136 |
| Non-JavaScript assets | 2,479,740 | 2,479,740 | 2,479,740 |

The raw category ceilings also bound the complete artifact by their sum. Fonts
retain their separate 2,105,000-byte ceiling. Initial and non-translation ceilings
are no higher than the previous baseline. Translation ceilings are literal measured
values: adding languages or growing their payload requires an explicit review.

Two runtime-preserving optimizations recover space: shared-types exposes an ESM
browser build, avoiding a second CommonJS Zod graph while retaining the server's
CommonJS entry; Metro emits UTF-8 text in external JavaScript files instead of
expanding non-ASCII text into Unicode escapes. No translated strings are removed.

The export temporarily generates source maps. `write-web-bundle-inventory.mjs`
classifies a translation only when **every source** belongs to Bloom's explicit
translation modules. It records each JavaScript file's SHA-256 outside `dist`, then
removes maps and their debug comments before deployment. The gate rejects missing
or stale inventory, missing initial scripts, and code disguised with a language-like
filename. An initial script always counts as initial, including an eager locale.

Run `bun run build:frontend`, `bun run check:web-bundle-budget`, and
`bun run test:performance-gates`. Mutation tests cover initial growth despite spare
translation capacity, false locale classification, stale provenance and font growth.

Both shared-types builds are project references: `bun run dev` watches and refreshes
the CommonJS and ESM outputs together. This was verified by changing a temporary
schema module and observing both outputs before removing the probe.

## Published SDK adoption (2026-10-04)

The published Oxy graph with Bloom 6.2.1 measures 352,661 gzip bytes for the same
1,028,965 raw translation bytes. All 135 translation files in the public Bloom
6.2.0 and 6.2.1 archives are byte-identical. Metro bundle/module identifiers change
with the dependency graph; the measured gzip total increases by 45 bytes while
the source payload and raw ceiling remain unchanged. The gzip ceiling is adjusted
to that exact measured total; all seven other ceilings are preserved. Local and
CI exports agree. This does not permit added languages or larger raw payloads.
