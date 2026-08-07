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
  creators: 'Task 13 — creators and uploads',
  rooms: 'Task 14 — rooms',
  user: 'Task 15 — user and recommendations',
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
 * It cannot express an owner that is cross-cutting, and
 * {@link UNPORTED_CATALOG_MODULES} has two: the MongoDB removal itself, and the
 * bulk loaders split out of it.
 *
 * Listed here so {@link LIVE_TASK_IDS} can be complete. Like `OWNING_TASKS`,
 * an entry is DELETED when its task closes — that deletion is what turns a
 * surviving `owner` into a failing gate rather than a green lie.
 */
export const CROSS_CUTTING_TASKS = {
  'Task 19': 'Remove MongoDB',
  /**
   * Split out of Task 19 by the Task 12 review (I4).
   *
   * Task 19 is gated on Task 8, which is blocked, so anything parked behind it
   * waits indefinitely. Three of the five bulk loaders fill tables whose READ
   * side is already on Postgres, so those readers query an empty table until
   * their loader moves — that is a half-connected mechanism rather than a
   * dormant script, and one of the three is a compliance path. They get an
   * owner that is not blocked.
   */
  'Task 19a': 'The bulk loaders (unblocked, split from Task 19)',
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
  // `'Task 13 — creators and uploads'` → `'Task 13'`. The vertical values carry
  // a description; the `owner` field is the bare id, so the id is taken from
  // the front rather than the two being maintained separately.
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
  Room: 'rooms',
  House: 'rooms',
  Recording: 'rooms',
  Report: 'moderation',
  ModerationEnforcement: 'moderation',
  ArtistClaim: 'creators',
  ContributionAttestation: 'creators',
  UserUpload: 'creators',
  CatalogRelation: 'user',
  ListeningEvent: 'user',
  UserMusicPreferences: 'user',
  UserTasteProfile: 'user',
} as const satisfies Record<string, OwningTask>;

export type NonCatalogModel = keyof typeof NON_CATALOG_MODEL_OWNERS;

/**
 * The models `schema/catalog.ts` owns. A file in the registry importing one of
 * these has not been ported, whatever else it does — this is the list property
 * 1 is checked against.
 *
 * Nineteen tables, ten model files: the four the Task 10b brief named plus the
 * six its selector missed (`IsrcRegistry` alone is imported by three services
 * that were never in the brief's list — see the report).
 */
export const CATALOG_MODELS = [
  'Track',
  'Album',
  'CatalogEntity',
  'ImageAsset',
  'TrackKey',
  'TrackFingerprint',
  'Lyrics',
  'MusicBrainzArtist',
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
    file: 'services/catalog/artistProfile.ts',
    models: ['ContributionAttestation'],
    reason:
      'Reads which of a profile\'s tracks a third party published. `contribution_attestations` ' +
      'is Task 13\'s table; the read returns a list of track ids and is never joined to a ' +
      'catalog table.',
  },
  {
    file: 'services/compliance/takedown.ts',
    models: ['ContributionAttestation', 'UserUpload'],
    reason:
      'The safe-harbour locker purge is entirely Task 13\'s vertical — it deletes `user_uploads` ' +
      'rows and their S3 objects. Only the catalog half (the track, its fingerprint, the ' +
      'responsible artist) is ported.',
  },
  {
    file: 'services/uploads/matchCatalog.ts',
    models: ['UserUpload'],
    reason:
      'Tier 1 also asks whether the uploader\'s OWN locker already holds these bytes. That half ' +
      'is Task 13\'s; the three catalog tiers are ported.',
  },
  {
    file: 'services/radio/radioFixtures.ts',
    models: ['CatalogRelation', 'UserTasteProfile'],
    reason:
      'Builds fixtures for both databases. The catalogue half is drizzle; the co-listen graph ' +
      'and taste weights belong to Task 15. `makeLibrary` writes `user_liked_tracks` since ' +
      'Task 11.',
  },
  {
    file: 'services/radio/radioSeed.ts',
    models: ['UserTasteProfile'],
    reason:
      'The user seed reads taste weights — Task 15\'s table — then hands a list of track ids to ' +
      'a Postgres query. The liked tracks beside them moved in Task 11, and so did the freshness ' +
      'ordering the seed reads off the tail of that list.',
  },
  {
    file: 'services/radio/radioPools.ts',
    models: ['CatalogRelation'],
    reason:
      'Pool 1 reads the co-listen graph — Task 15\'s `catalog_relations` — for a ranked list of ' +
      'track ids, then looks them up in Postgres.',
  },
  {
    file: 'services/recommendations/taste.ts',
    models: ['CatalogRelation'],
    reason: '`topRelatedArtistIds` folds the co-listen graph across seeds. Task 15\'s table.',
  },
  {
    file: 'services/recommendations/recommendationService.ts',
    models: ['CatalogRelation', 'ListeningEvent', 'UserTasteProfile'],
    reason:
      'Every personalised read starts from a taste profile and a listening history (Task 15) ' +
      'and ends in a Postgres catalog query keyed on the ids they return. The library half is ' +
      'drizzle since Task 11.',
  },
  {
    file: 'services/recommendations/recordPlay.ts',
    models: ['ListeningEvent', 'UserTasteProfile'],
    reason:
      'Writes the immutable listening event and folds the play into the taste profile — both ' +
      'Task 15 — while the play counters it increments are catalog columns.',
  },
  {
    file: 'services/recommendations/tasteSignals.ts',
    models: ['UserTasteProfile'],
    reason:
      'Folds a like or a follow into the taste profile (Task 15). The two catalog reads behind ' +
      'the signal are ported.',
  },
  {
    file: 'controllers/stream.controller.ts',
    models: ['UserMusicPreferences'],
    reason:
      'Reads the listener\'s audio-quality and data-saver settings to compute a bitrate cap. ' +
      '`user_music_preferences` EXISTS in `schema/user.ts`, so this is not a capability gap — ' +
      'but `musicPreferences.controller` still WRITES the Mongo document, and a reader on ' +
      'Postgres against a writer on Mongo is a split brain, not a split read. It moves when its ' +
      'writer does, in Task 15.',
  },
  {
    file: 'controllers/artists.controller.ts',
    models: ['ArtistClaim', 'ContributionAttestation'],
    reason:
      'Two of Task 13\'s tables, for two different reasons. `artist_claims` is a queue this ' +
      'controller reads and writes but never joins to the catalogue — the GRANT is a Postgres ' +
      'update, and it is atomic there. `contribution_attestations` is what makes a track a ' +
      'contribution, and it was ONE `$lookup` from `tracks`; the split turns it into three ' +
      'bounded round trips (see `loadContributedTrackIds`). `copyright_reports` was in this ' +
      'list and is NOT any more: `tracks.copyright_report_id` is a real foreign key, so a ' +
      'Mongo id in that column fails the constraint — a hybrid split survives a cross-vertical ' +
      'READ and cannot survive a cross-vertical FOREIGN KEY.',
  },
  {
    file: 'controllers/queue.controller.ts',
    models: ['UserUpload'],
    reason:
      'The queue is addressed by `(kind, id)` across TWO stores: the catalogue (Postgres) and ' +
      'the private locker (`user_uploads`, Task 13). The catalog half is drizzle; the locker ' +
      'half keeps its Mongoose read because `toUploadTrackDto` — the allowlist DTO that is the ' +
      'locker\'s only serializer — lives in `uploads.controller` and moves with it.',
  },
  {
    file: 'controllers/library.controller.ts',
    models: ['ListeningEvent'],
    reason:
      'Task 11 took the memberships and the play log to drizzle, which is most of this file; ' +
      'what survives is the `LISTENING_SOURCES` union it validates a client-supplied source ' +
      'against before handing it to `recordPlay`, and that constant lives on Task 15\'s model.',
  },
  {
    file: 'moderation/enforcement-service.ts',
    models: ['House', 'ModerationEnforcement', 'Report', 'Room'],
    reason:
      'Carrying out a decision reaches four different nouns, and they now live in two stores. ' +
      'The TRACK and PLAYLIST restrictions are drizzle (Task 11 ported both, having found them ' +
      'reading Mongo collections whose rows had already moved — see the note on the sweep ' +
      'below); houses and rooms are Task 14\'s, and the enforcement ledger and report taxonomy ' +
      'are Task 8\'s, which is blocked. No branch joins the two stores: each is a switch case ' +
      'that reads and writes one noun.',
  },
  {
    file: 'moderation/subjects/providers.ts',
    models: ['House', 'Recording', 'Report', 'Room'],
    reason:
      'Five subject providers, same split and same reason as `enforcement-service` above: the ' +
      'playlist, track and artist snapshots are drizzle, houses and rooms are Task 14\'s. ' +
      '`ReportedType` is an enum on Task 8\'s model rather than a query.',
  },
  {
    file: 'utils/syraMedia.ts',
    models: ['Room'],
    reason:
      'Resolves a media reference across the catalogue and the live-rooms vertical. `rooms` is ' +
      'Task 14\'s table; the catalog half reads Postgres. This file is also the reason ' +
      '`halfPortedImports.test.ts` resolves import paths instead of matching specifier text — ' +
      'it lives in `src/utils/`, so it reaches its neighbours as `./x`.',
  },
  {
    file: 'controllers/radio.controller.ts',
    models: ['UserMusicPreferences'],
    reason:
      'Reads the explicit-content preference to decide what the station may programme. Same ' +
      'writer, same task, same reason as `stream.controller` above.',
  },
] as const;

/**
 * Catalog services that are NOT hybrid and are NOT ported — the other residue,
 * kept beside the registry so one file answers "what is left".
 *
 * These are held to a DIFFERENT property by the gate: each must still import the
 * catalog model named, so an entry cannot outlive the work it describes. They
 * are deliberately not in {@link HYBRID_MODULES}, because that registry means
 * "ported, with a licence to read another vertical" and these are unported.
 */
export const UNPORTED_CATALOG_MODULES: readonly {
  readonly file: string;
  readonly models: readonly CatalogModel[];
  /**
   * The task that will port or delete this file — a BARE id, exactly as it
   * appears in {@link LIVE_TASK_IDS}, and compared by identity.
   *
   * Nothing else goes in here. Task 12 first recorded a re-ownership as
   * `'Task 19 — MongoDB removal (re-owned from the closed Task 10)'`, which is
   * accurate prose and defeats the only check that matters: an exact
   * comparison against the live set becomes impossible the moment the field
   * carries anything but the id. Provenance goes in {@link reownedFrom}.
   */
  readonly owner: string;
  /** The task this entry was moved AWAY from, when it was moved. */
  readonly reownedFrom?: string;
  readonly reason: string;
}[] = [
  {
    file: 'controllers/uploads.controller.ts',
    models: ['Album', 'CatalogEntity', 'ImageAsset', 'Track', 'TrackFingerprint', 'TrackKey'],
    owner: 'Task 13',
    reason:
      'The creator upload path — 2,779 lines, and the 42 failures Task 10c inherited to Task 13 ' +
      'all live behind it. It reads SIX catalog models AND `db/catalog/serialize`, which is why ' +
      'it belongs here rather than in HYBRID_MODULES: that registry means "ported, with a licence ' +
      'to read another vertical\'s models", and property 1 would correctly refuse a file holding ' +
      'this many of its OWN vertical\'s models. Task 10c-3 swapped one import (`normalizeImageRef`) ' +
      'and touched nothing else.',
  },
  // ── Operational scripts ────────────────────────────────────────────────
  //
  // SIX scripts that read or write catalog collections whose tables moved in
  // Task 10, found by property 4's sweep in Task 11 and registered rather than
  // ported: none of them is on any vertical's file list, and they are not this
  // task's to rewrite. (Counted, not remembered — the first version of this
  // comment said five above a list of six.) They are all BROKEN today in the same way — a Mongoose
  // read against a collection the application no longer writes returns nothing,
  // and a Mongoose write lands where nothing looks. Named individually so
  // whoever picks them up gets a list rather than a category.
  {
    file: 'scripts/seedMusicData.ts',
    models: ['Album', 'CatalogEntity', 'Track'],
    owner: 'Task 19',
    reownedFrom: 'Task 10 (closed)',
    reason:
      'DORMANT. Seeds a development catalogue into Mongo; nothing reads that catalogue any ' +
      'more, and the Postgres tables it would fill are written by the real upload path. No ' +
      'reader is starved by leaving it, so it can wait for the MongoDB removal itself.',
  },
  {
    file: 'scripts/backfillTrackFingerprints.ts',
    models: ['Track', 'TrackFingerprint'],
    owner: 'Task 19a',
    reownedFrom: 'Task 10 (closed)',
    reason:
      'HALF-CONNECTED, and the most serious of the three: `services/compliance/takedown.ts:300` ' +
      'matches fingerprints out of Postgres while the only thing that fills them still writes ' +
      'Mongo, so takedown fingerprint matching runs against an empty table. A COMPLIANCE path ' +
      'silently matching nothing is not a dormant script, and it must not wait behind Task 8.',
  },
  {
    file: 'scripts/importIsrcRegistry.ts',
    models: ['IsrcRegistry'],
    owner: 'Task 19a',
    reownedFrom: 'Task 10 (closed)',
    reason:
      'HALF-CONNECTED. The three SERVICES that read the ISRC registry were ported in Task 10b ' +
      '(missed by the same selector that missed this); the importer that fills it was not, so ' +
      '`services/uploads/isrcLookup.ts:384` matches an uploader-supplied ISRC against an empty ' +
      'table.',
  },
  {
    file: 'scripts/importMusicBrainzArtists.ts',
    models: ['MusicBrainzArtist'],
    owner: 'Task 19a',
    reownedFrom: 'Task 10 (closed)',
    reason:
      'HALF-CONNECTED. `services/uploads/enrichCatalogEntity.ts:43` reads the MusicBrainz artist ' +
      'mirror from Postgres and this is the only thing that fills it, so artist enrichment ' +
      'silently finds nothing on every upload.',
  },
  {
    file: 'scripts/importDiscogsReleases.ts',
    models: ['DiscogsRelease'],
    owner: 'Task 19',
    reownedFrom: 'Task 10 (closed)',
    reason:
      'DORMANT. Bulk-loads the Discogs release mirror, and `discogs_releases` has NO reader at ' +
      'all — neither database. Nothing is starved by leaving it, which is what separates it ' +
      'from the three above rather than the fact that it is a script.',
  },
  // `services/uploads/{acoustid,isrcLookup,provenanceSignals}.ts` were listed
  // here — missed by the Task 10b brief's selector, which keyed on four model
  // names while `schema/catalog.ts` owns nineteen tables. They are ported now,
  // and this gate is what said so: all three failed the "still imports what it
  // is listed for" assertion the moment the imports went, which is the stale
  // direction firing on real work rather than on a fixture.
] as const;
