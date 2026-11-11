# A zod DTO field with no storage is invisible to tsc

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

Because the zod schema is the source of the TypeScript type, a DTO field can
never disagree with itself — so nothing at compile time notices a field that is
in the contract, returned to clients, asserted by a passing test, and stored
nowhere. That was `catalog_entities.members`, which had a live reader.

`src/db/__tests__/zodPathsExistInDrizzle.test.ts` is the standing gate: every
zod DTO field must resolve to a drizzle column, a foreign key, a child table or
an explicit registry entry. When adding a field to a DTO, add its storage in the
same change.

**Only one direction needs a runtime gate.** Drizzle rejects an unknown column
key at COMPILE time, so a write to an undeclared column cannot compile. The
direction above still needs the gate, because nothing forces a DTO to be written
through a table at all.

Two traps the gate handles structurally, both worth knowing when reading it:

- **Flattening.** Nested DTO objects map to column prefixes
  (`links.wikidata` → `links_wikidata`, `cache.s3Key` → `cache_object_key`), and
  others to a foreign key (`imageSizes.small` → `image_sizes_small_id`
  → `image_assets`). A naive one-to-one name match reports a correct schema as
  broken. The rule that covers flattening, `jsonb` subdocuments and foreign keys
  at once is **descend only into what does not already resolve**.
- **`ZodArray.unwrap()` returns the ELEMENT type in zod 4.** An unwrap loop that
  calls `.unwrap()` on anything that has it will walk into array items, whatever
  its comment says. Unwrap optionality only, so an array stays one path.
