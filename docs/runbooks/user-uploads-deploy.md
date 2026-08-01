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

## 1. `bun run ensure-indexes -- --dry-run`

Reports which indexes are missing, and which existing duplicate rows would block
a unique index from building. Writes nothing.

Run this **first, and against production**, not against a staging copy: the
duplicates it finds are properties of real data, and staging does not have them.

### How far the dry run can be trusted

It tells you **which indexes are missing** and **which duplicates block a
build**. It **cannot validate the definitions it would create**, because it
shares the code that generates them.

That is not a theoretical caveat. During development the index planner mistook
the base schema of a discriminated model for a discriminator (its
`discriminatorMapping.value` is `null`, not `undefined`) and stamped
`partialFilterExpression: { type: null }` onto six indexes — a filter matching no
documents at all. Those six would have been reported `MISSING`, then created
successfully, then reported `CREATED`, and indexed nothing. Every signal
available to the operator would have said the job worked.

The guard against that class is `src/scripts/ensureIndexes.test.ts`, which
compares the planner's output against the indexes Mongoose itself builds — an
independent oracle. Trust the dry run for coverage, not for correctness.

---

## 2. Merge or delete the duplicates the dry run named

**Expect the first `ensure-indexes` run to fail. That is the script working.**

Nothing has ever enforced artist name uniqueness, so duplicate `nameKey` values
almost certainly exist in production and the unique index cannot build until they
are resolved. The same risk applies to `Track.externalIds.isrc`.

The script prints the offending groups with their document ids, because "E11000"
on its own leaves whoever is mid-deploy with no next step. Merge or remove those
rows, then continue.

Anyone who hits an unexplained `E11000` here without having read this will assume
the script is broken and stop. It is not — the constraint is being enforced for
the first time against data that predates it.

---

## 3. `bun run ensure-indexes`

Builds every index declared in every schema. Reports created / already present /
failed per index, and exits non-zero if any failed.

This matters beyond this feature. `utils/database.ts` disables `autoIndex` in
production and nothing else in the backend has ever created an index, so **every
index in every schema has been declarative only in production** — including
constraints the existing code already assumes, such as `Track.externalIds.isrc`,
`Album.upc`, `CatalogEntity.linkedOxyUserId`, `Podcast.feedUrl` and
`Episode {podcastId, guid}`.

---

## 4. `bun run reseed:persons`

**Must come after step 3, and after it specifically.**

`Person.nameKey` values written before this feature used a weaker normalisation
(`trim().toLowerCase()`) and will not match lookups for any name carrying an
accent or punctuation. The reseed replays every credit through the current
resolver and rewrites them.

It comes last of the identity steps because it **writes the very `nameKey` values
the unique index guards**, and because it generates new values under the
Latin-only diacritic rule. Running it before the index exists means writing
unconstrained data that the index then refuses to build over.

---

## 5. `bun run backfill:fingerprints`

Acoustically indexes the catalogue that predates the fingerprint write.

Independent of steps 1–4 — it reads `tracks` and writes a new collection — so it
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
- `ensure-indexes` exits 0 with zero failures.
- A second `ensure-indexes` run reports everything already present and creates
  nothing.
- `backfill:fingerprints` reports `failed: 0`, or the failures are understood.
