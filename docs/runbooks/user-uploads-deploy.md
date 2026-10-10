# Deploy runbook — user uploads (private locker + catalogue contribution)

One-time steps that must run against production when the user-upload feature
ships. **The order is not interchangeable** — each step depends on the previous
one having completed, for the reasons given below.

Everything here is idempotent and safe to re-run. Nothing here is optional:
until each step completes, the behaviour it enables is inert in production while
the code that reads it looks correct.

---

## 0. Before you start

**Set `SYRA_COMPLIANCE_REVIEWERS` in SSM.**

Both review queues are **fail-closed**: with the variable unset, every review
endpoint answers `403` to everyone, so no copyright report and no artist claim
can ever be resolved. Shipping the public contribution path with this unset is
the worst available combination — the door open and the takedown mechanism off.

Verify it before anything else, because it is the only step here whose absence
is silent AND unbounded.

---

## 1. `bun run reseed:persons`

`Person.nameKey` values written before this feature used a weaker normalisation
(`trim().toLowerCase()`) and will not match lookups for any name carrying an
accent or punctuation. The reseed replays every credit through the current
resolver and rewrites them.

It rewrites those `nameKey` values under the current Latin-only diacritic rule,
so it must run before anyone relies on accent- or punctuation-insensitive person
lookups.

---

## 2. `bun run backfill:fingerprints`

Acoustically indexes the catalogue that predates the fingerprint write.

Independent of step 1 — it reads `tracks` and writes its own table — so it
can run last, and it is the only step here that is safe to run in bounded passes
during a quiet window:

```
bun run backfill:fingerprints -- --dry-run
bun run backfill:fingerprints -- --limit 500
bun run backfill:fingerprints
```

It streams every track's audio out of S3 and runs `fpcalc`, so it is long-running
and **will** be interrupted. It skips tracks that already have a row, so
re-running resumes rather than restarts.

If `fpcalc` is missing it **aborts immediately** rather than recording a failure
per track — a run that "completed" having indexed nothing because the binary was
absent would report counts indistinguishable from a catalogue with no
fingerprintable audio.

**Until this completes, two behaviours are no-ops for the existing catalogue** no
matter how correct their code is:

- acoustic dedup (`matchCatalog` tier 3) compares every upload against an empty
  bucket and always abstains;
- the re-encode leg of the takedown purge finds nothing, so a takedown reaches
  only byte-identical locker copies and misses every transcode.

---

## Verifying the deploy

- `SYRA_COMPLIANCE_REVIEWERS` is set, and a reviewer account can load the claim
  queue rather than receiving `403`.
- `reseed:persons` exits 0.
- `backfill:fingerprints` reports `failed: 0`, or the failures are understood.
