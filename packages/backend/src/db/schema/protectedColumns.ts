/**
 * Columns That Must Not Reach a Client — the `select: false` replacement
 *
 * Mongoose can mark a field so sensitive it is absent from every read unless a
 * caller asks for it by name. Drizzle enumerates columns explicitly, so a
 * naive port keeps no such guard at all: `db.select().from(table)` returns
 * every column, secrets included, with nothing in the call site naming what
 * leaked.
 *
 * This module holds THIS schema's registry — decided once for every table
 * rather than per call site. The mechanism that reads it (`publicColumns`, the
 * implicit-whole-row-read scanner `findImplicitWholeRowReads`) is shared
 * plumbing with no opinion on which columns to protect, so it lives in
 * `@oxyhq/db/assert` instead of here; this file supplies only the DATA.
 *
 * ## The mechanism
 *
 * 1. **The registry is data** (`PROTECTED_COLUMNS_BY_TABLE`), one entry per
 *    table naming the columns it protects — the same shape as
 *    `deferredForeignKeys.ts`, and for the same reason: a rule written only
 *    in a comment is a rule nothing checks.
 * 2. **`publicColumns(table, PROTECTED_COLUMNS_BY_TABLE)`, imported from
 *    `@oxyhq/db/assert`, is the sanctioned read.**
 *    `db.select(publicColumns(users, PROTECTED_COLUMNS_BY_TABLE)).from(users)`
 *    omits every protected column AT THE TYPE LEVEL — the resulting row type
 *    has no property for it at all, so a serializer that tries to read one
 *    fails `tsc` rather than shipping it.
 * 3. **Opting in is explicit and greppable.** A path that legitimately needs a
 *    protected column names it: `db.select({ id: t.id, secret: t.secret })`.
 *    There is deliberately no helper for this — the whole point is that it
 *    reads differently from an ordinary select.
 * 4. **`__tests__/gates.test.ts` is the gate.** It calls
 *    `@oxyhq/db/assert`'s `findImplicitWholeRowReads` to scan `src/` for the
 *    two shapes that return every column implicitly regardless of whether
 *    `publicColumns` exists — a bare `.select()` and the relational
 *    `db.query.<table>` API — against any table in this registry.
 *
 * Each schema task that ports a model with a Mongoose `select: false` field
 * (or any column that must not reach a client even though Mongoose never
 * marked it) adds an entry here in the same change.
 *
 * `PROTECTED_COLUMNS_BY_TABLE` must stay declared `as const` and be passed
 * straight through to `publicColumns` at every call site — see that
 * function's own doc comment in `@oxyhq/db/assert` for exactly what widening
 * it (an explicit `: ProtectedColumnRegistry` annotation, or passing it
 * through an intermediate parameter typed that way) would cost: the runtime
 * filter stays correct either way, but the compile-time guarantee collapses.
 *
 * Keyed here by SQL table name (`publicColumns`'s own contract — see its doc
 * comment in `@oxyhq/db/assert`), and each entry lists TypeScript PROPERTY
 * names, not SQL column names (`publicColumns` reads the registry against
 * `Object.entries(getTableColumns(table))`, whose keys are the drizzle
 * property names).
 *
 * `catalog_entities.images` / `catalog_entities.imageSuggestions` and
 * `tracks.images` / `tracks.sha256` are every field the Mongoose serializer's
 * `stripExternalCatalogFields` deleted before Task 11 removed it with
 * `utils/musicHelpers.ts`. That guard was one hand-maintained `delete` list
 * behind thirteen formatters, so a field it missed was exposed by all of them
 * at once the moment a route stopped being a Mongoose `find()` (which honoured
 * `select: false`) and became an aggregation (which does not) — which happened
 * once, to `imageSuggestions`. This registry replaces it by removing the column
 * from the ROW TYPE, so naming one fails `tsc` rather than shipping.
 */

export const PROTECTED_COLUMNS_BY_TABLE = {
  catalog_entities: ['images', 'imageSuggestions'],
  tracks: ['images', 'sha256'],
  /**
   * `rawTags*` is the port of Mongoose `select: false` on `UserUpload
   * .rawTags` — the file's native tag block, which must never reach a
   * client. `fingerprint` and `sha256` were never marked in Mongoose and are
   * registered here anyway: the model's own doc comment calls the
   * fingerprint server-only ("exposing it would hand a client the acoustic
   * index it would need to enumerate the catalog"), and `sha256` is the same
   * audio content hash `tracks.sha256` above is protected for.
   *
   * The storage keys (`audioSourceKey`, `hlsMasterKey`) are deliberately NOT
   * here — `catalog.ts` does not protect the identical columns on `tracks`,
   * and the hand-written `toUploadTrackDto` allowlist is the guard for both
   * verticals. See `schema/creators.ts`'s file-level doc comment.
   */
  user_uploads: ['rawTagsFormat', 'rawTagsJson', 'rawTagsTruncated', 'rawTagsOriginalByteLength', 'fingerprint', 'sha256'],
  /**
   * The same `select: false` `rawTags` block, duplicated onto the
   * attestation because the upload can be deleted and the evidence for a
   * published recording has to outlive it — plus `ip`/`userAgent`, which
   * Mongoose never marked either. Those two are request context about a
   * person, held as legal evidence; no client has ever been served them and
   * none should be.
   */
  contribution_attestations: ['rawTagsFormat', 'rawTagsJson', 'rawTagsTruncated', 'rawTagsOriginalByteLength', 'ip', 'userAgent'],
  /**
   * The four internal stream credentials `PUBLIC_ROOM_FIELDS`
   * (`routes/rooms.routes.ts:70-104`) exists to withhold. Mongoose never
   * marked any of them `select: false` — the guard has always been that
   * hand-written allowlist, and `routes/streamCredentialExposure.test.ts`
   * exists because an earlier implementation of it silently failed to strip
   * them from a hydrated document.
   *
   * `rtmpStreamKey` in particular is a live RTMP PUBLISHING key: leaking it
   * hands a stranger the ability to broadcast into someone else's room, so
   * this is a write capability, not merely a private field. Registering all
   * four gives the Postgres port a second, independent guard —
   * `findImplicitWholeRowReads` refuses a bare `db.select().from(rooms)`
   * outright, before any serializer gets the chance to forget.
   *
   * `recordings.objectKey` is deliberately absent: `catalog.ts` does not
   * protect the identical `tracks.audioSourceKey`/`hlsMasterKey`, and a
   * storage key is guarded by hand-written DTO allowlists in both verticals
   * (see this file's note on `user_uploads`). See `schema/rooms.ts`'s
   * file-level doc comment.
   */
  rooms: ['rtmpStreamKey', 'rtmpUrl', 'activeStreamUrl', 'activeIngressId'],
  /**
   * One person's muted words and the accounts they have restricted. Mongoose
   * never marked either `select: false`, and they are on the wire TODAY:
   * `GET /api/profile/settings/:userId` (`routes/profileSettings.ts:41`) serves
   * any account's whole settings document to any authenticated caller, because
   * `ensureUserSettings` narrows the TypeScript type with
   * `.lean<UserSettingsLean>()` but never projects — the type says four fields,
   * the object carries all of them.
   *
   * Registering the two lists gives the Postgres port a structural guard
   * (`findImplicitWholeRowReads` refuses a bare `db.select().from(userSettings)`)
   * rather than leaving it to whoever ports that route to notice. The rest of
   * `privacy` is deliberately absent: the booleans and `profileVisibility`
   * describe how a profile renders to other people, which is the part of this
   * document a viewer is meant to see.
   */
  user_settings: ['privacyHiddenWords', 'privacyRestrictedUsers'],
} as const;
