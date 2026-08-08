/**
 * The HYBRID MODULE REGISTRY — which catalog modules may still import a
 * Mongoose model, which models, and who owns each.
 *
 * Services when Task 10b wrote it; controllers joined in 10c, which is why the
 * names say MODULE. Nothing else about the shape changed: a controller reading
 * another vertical's model is the same split as a service doing it.
 *
 * ## Why this exists
 *
 * Task 10b's completion check was supposed to be "a file is ported when its
 * model import is gone". That check does not survive the vertical split: the
 * plan ports one vertical per task (catalog 10, library 11, podcasts 12,
 * creators 13, rooms 14, user 15), and ten catalog services also read models
 * three LATER tasks own. Porting those here would take their files out of their
 * scope; leaving them means a file that is half on each database.
 *
 * A half-ported file is SPLIT, not broken — measured, not assumed: there is not
 * one `$lookup` across the twenty-three services, so every cross-vertical read
 * was already a separate round trip returning a list of ids, and a second round
 * trip against a second database returns the same ids.
 *
 * What the split costs is the completion check, and a residue that lives only
 * in a task report is exactly what gets lost between tasks. So it lives here,
 * and `__tests__/hybridServices.test.ts` holds it to two properties:
 *
 *   1. **No registered file imports a CATALOG model.** The registry is a licence
 *      to keep reading ANOTHER vertical's models, never this one's.
 *   2. **A registered file imports only its registered models — exactly.** An
 *      unregistered import fails as an oversight; a registered model the file no
 *      longer imports fails as STALE. The second direction is what makes the
 *      registry shrink to nothing as Tasks 11, 13 and 15 land, instead of
 *      quietly outliving its reason the way an exemption list does.
 *
 * ## The rule this registry is written under
 *
 * Every entry is compared BY IDENTITY, never by substring. The over-long
 * identifier exemption on this branch shipped with `includes()` and silently
 * absorbed a 74-byte superstring of an exempt name; `halfPortedImports.test.ts`
 * shipped with `endsWith()` and missed a whole spelling. Both are the same bug,
 * and both were caught only after the fact. The gate's own fixtures put a
 * superstring and a substring on the wrong side of every match it makes.
 */

/** The verticals a still-Mongoose model can belong to, and the task that owns it. */
export const OWNING_TASKS = {
  // `library` is GONE, and its absence is the record that Task 11 landed: no
  // still-Mongoose model belongs to that vertical any more. `Playlist`,
  // `PlaylistTrack` and `RecentlyPlayed` were deleted with it, and `Library`
  // was re-owned to `podcasts`.
  //
  // `podcasts` is GONE for the same reason, and it took `Library` with it:
  // Task 12 ported `podcasts`, `episodes` and `episode_progress`, which made
  // `user_podcast_subscriptions` insertable and let `models/Library.ts` — the
  // one-field remnant Task 11 left behind — be deleted outright. Four models
  // (`Podcast`, `Episode`, `EpisodeProgress`, `Library`) left the tree with it.
  //
  // `creators` is GONE for the same reason again: Task 13 ported the locker and
  // the three moderation records, and five models left the tree with it —
  // `UserUpload`, `ArtistClaim`, `ContributionAttestation`,
  // `ContributorStanding`, and `TrackKey`, whose last consumer was
  // `uploads.controller`.
  //
  // `rooms` is GONE for the same reason once more: Task 14 ported houses,
  // series, rooms, recordings and the live-presence preference, and FIVE models
  // left the tree with it — `House`, `Room`, `Series`, `Recording` and
  // `RoomUserPreference`. `Series` and `RoomUserPreference` never appeared in
  // `NON_CATALOG_MODEL_OWNERS` below because no catalog module ever read them.
  //
  // `user` is GONE, and it is the LAST vertical to go: Task 15 ported settings,
  // music preferences, behavior, taste profiles, listening events, the co-listen
  // graph and both notification tables, and EIGHT models left the tree with it —
  // `UserSettings`, `UserMusicPreferences`, `UserBehavior`, `UserTasteProfile`,
  // `ListeningEvent`, `CatalogRelation`, `NotificationPreference` and
  // `NotificationSuppression`. The last four of those were in
  // `NON_CATALOG_MODEL_OWNERS` below and are gone from it; the other four never
  // were, because no catalog module read them.
  //
  // Only `moderation` is left, which is why this map is one entry long.
  // Task 8 is BLOCKED on an owner decision, so its models have no port in
  // sight. Registered anyway, because two files hold Postgres reads beside
  // them and property 3's sweep finds those files whether or not the task is
  // startable — an unregistered hybrid is not made acceptable by its owning
  // task being blocked.
  moderation: 'Task 8 — moderation (blocked on an owner decision)',
} as const;

export type OwningTask = keyof typeof OWNING_TASKS;

/**
 * Tasks that own registry entries WITHOUT owning a vertical.
 *
 * {@link OWNING_TASKS} is keyed by vertical, which is right for
 * {@link NON_CATALOG_MODEL_OWNERS} — every still-Mongoose model belongs to one.
 * It cannot express an owner that is cross-cutting, which
 * `UNPORTED_CATALOG_MODULES` needed while it existed (the MongoDB removal
 * itself, and the bulk loaders split out of it).
 *
 * Listed here so {@link LIVE_TASK_IDS} can be complete. Like `OWNING_TASKS`,
 * an entry is DELETED when its task closes — that deletion is what turns a
 * surviving `owner` into a failing gate rather than a green lie.
 */
export const CROSS_CUTTING_TASKS = {
  'Task 19': 'Remove MongoDB',
  // `Task 19a` — the three half-connected bulk loaders split out by the Task 12
  // review — is CLOSED and therefore gone from this map, which is what makes any
  // surviving `owner: 'Task 19a'` fail rather than read as green.
} as const;

/**
 * Every task id that may appear in an `owner` field — the LIVE set.
 *
 * This is the gate `hybridServices.test.ts` checks membership against, and it
 * exists because the previous check was `toContain('Task ')`: a substring test
 * that passes for `Task 10`, a CLOSED task, and equally for `Task 999`. Five
 * entries named a finished task for three tasks running, on the one field that
 * could have caught it — the fifth instance of substring-where-identity-was-
 * meant on this branch, and the first sitting on the check that would have
 * found the others.
 *
 * The discovering property is the deletion: an owner leaves this set when its
 * task closes (its `OWNING_TASKS` or `CROSS_CUTTING_TASKS` entry is removed,
 * which is already the convention — see `library` and `podcasts`), and every
 * registry entry still naming it goes red on the next run. Nobody has to
 * remember to audit; the audit is what closing a task already does.
 */
export const LIVE_TASK_IDS: readonly string[] = [
  // `'Task 15 — user and recommendations'` → `'Task 15'`. The vertical values
  // carry a description; the `owner` field is the bare id, so the id is taken
  // from the front rather than the two being maintained separately. (The
  // example was Task 14's until that task closed and its entry was deleted,
  // and Task 13's before that — a comment naming a value the map no longer
  // holds is the same staleness the deletion convention exists to prevent.)
  ...Object.values(OWNING_TASKS).map((value) => value.split(' — ')[0] ?? value),
  ...Object.keys(CROSS_CUTTING_TASKS),
];

/**
 * Every Mongoose model a hybrid catalog service is still allowed to import,
 * mapped to the task that will remove it.
 *
 * A model NOT in here cannot be registered against any file — which is what
 * stops the registry becoming a general-purpose "this import is fine" list.
 */
export const NON_CATALOG_MODEL_OWNERS = {
  Report: 'moderation',
  ModerationEnforcement: 'moderation',
} as const satisfies Record<string, OwningTask>;

export type NonCatalogModel = keyof typeof NON_CATALOG_MODEL_OWNERS;

/**
 * The models `schema/catalog.ts` owns. A file in the registry importing one of
 * these has not been ported, whatever else it does — this is the list property
 * 1 is checked against.
 *
 * Nineteen tables, eight model files: the four the Task 10b brief named plus the
 * six its selector missed (`IsrcRegistry` alone is imported by three services
 * that were never in the brief's list — see the report), less
 * `MusicBrainzArtist`, whose model file Task 19a deleted once its importer was
 * the last one left, and less `TrackKey`, deleted by Task 13 for the same
 * reason: `uploads.controller` was its last consumer. A name leaves this list
 * when its model file leaves the tree — the convention Task 12 set with
 * `Podcast`, `Episode`, `EpisodeProgress` and `Library`.
 */
export const CATALOG_MODELS = [
  'Track',
  'Album',
  'CatalogEntity',
  'ImageAsset',
  'TrackFingerprint',
  'Lyrics',
  'IsrcRegistry',
  'DiscogsRelease',
] as const;

export type CatalogModel = (typeof CATALOG_MODELS)[number];

export interface HybridModule {
  /** Path relative to `src/`, exactly as the walk reports it. */
  readonly file: string;
  /**
   * The non-catalog models this file may still import — EXACTLY, in any order.
   * Not a minimum: a model listed here and no longer imported fails the gate.
   */
  readonly models: readonly NonCatalogModel[];
  /** Why this file cannot be finished inside Task 10b. */
  readonly reason: string;
}

/**
 * The ten hybrid services, measured from the ported tree rather than from the
 * brief's file list.
 *
 * `services/radio/radioFixtures.ts` is here despite being a test-fixture module:
 * it is compiled application source, it writes both databases, and a registry
 * that exempted it would be exempting the one file most likely to drift.
 */
export const HYBRID_MODULES: readonly HybridModule[] = [
  {
    file: 'moderation/enforcement-service.ts',
    models: ['ModerationEnforcement', 'Report'],
    reason:
      'Every RESTRICTION this file applies is drizzle now — tracks and playlists since Task 11, ' +
      'houses and rooms since Task 14. What keeps it registered is the enforcement LEDGER it ' +
      'writes each decision to and the report taxonomy it switches on, both Task 8\'s, which is ' +
      'blocked. No branch joins the two stores: each is a switch case that reads and writes one ' +
      'noun, and the ledger write is the same for every case.',
  },
  {
    file: 'moderation/subjects/providers.ts',
    models: ['Report'],
    reason:
      'All FIVE subject providers read Postgres now — the playlist, track and artist snapshots ' +
      'since Task 11, the house and room ones (and the room\'s recording-existence probe) since ' +
      'Task 14. The single remaining import is `ReportedType`, an enum on Task 8\'s model rather ' +
      'than a query: this file issues no Mongo read at all, and is registered only because that ' +
      'enum still lives on a Mongoose model.',
  },
] as const;

/**
 * `UNPORTED_CATALOG_MODULES` used to live here: files that imported a catalog
 * Mongoose model and had not been ported, each licensed with an owning task.
 *
 * IT IS GONE, AT ZERO, which is the outcome this file's own vacuity-floor
 * comment prescribed — "an exemption list with no exemptions is a file that can
 * only rot". Task 19a emptied it by deleting its last two entries
 * (`scripts/seedMusicData.ts` and `scripts/importDiscogsReleases.ts`) rather
 * than porting them; see the note where they were listed.
 *
 * The GATE it fed did not go with it, and that is the point. `property 4` in
 * `__tests__/hybridServices.test.ts` still sweeps every file under `src/` for a
 * catalog-model import — it now asserts there are NONE, which is the finish
 * line the sweep's own doc comment always named ("not 'no file holds both
 * sides' but 'no file imports a catalog model at all'"). An exact zero is a
 * stronger check than a licence list, and unlike the list it cannot rot,
 * because the sweep runs against the real tree every time.
 */
