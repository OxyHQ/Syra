# Server-only fields: the protected-column registry

Moved from the root `AGENTS.md` on 2026-11-11 without rule changes.

A field is kept out of a response by ONE mechanism: `PROTECTED_COLUMNS_BY_TABLE`
(`db/schema/protectedColumns.ts`). `db/catalog/serialize.ts` derives its row
shapes from the drizzle table type MINUS that table's protected columns
(`PublicTrackRow = Omit<typeof tracks.$inferSelect, …>`), so the registry is the
single source of truth and **a serializer that still names a newly-protected
column stops compiling**. That is strictly stronger than anything a serializer
can do by hand, because it fails before the code runs rather than on the one
route nobody exercised.

Two rules survive from the denylist era, and both are about how you VERIFY a
guard rather than which guard you picked:

- **An allowlist beats a denylist, so prefer a DTO that names every key it
  returns** (`toTrackDto`, `toAlbumDto`, `toUploadTrackDto`). A field added to
  the table tomorrow is excluded by default. Do NOT add a `delete` beside one: it
  can never fire, and it advertises a denylist where the real guard is an
  allowlist.
- **Mutation-test which guard is load-bearing** — remove it and confirm the test
  goes red naming the field. And never read a guard's presence from its comment;
  a guard can be removed while the comment asserting it survives.

`controllers/serverOnlyFields.leak.test.ts` is the standing gate for the whole
class, and covers the catalogue, the locker (`user_uploads`) and attestations in
one place. Its header records what the leak looked like when the guards were a
per-field exclusion plus an untyped spreading formatter. Keep that record: it is
why the registry exists.

Not a leak, and must not be "fixed" into one: `catalog_entities`' four
`imageLicence*` columns are public on purpose. CC BY-SA is satisfied BY
displaying the author and licence; hiding them would be the breach.
