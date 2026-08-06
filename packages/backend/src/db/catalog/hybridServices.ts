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
  library: 'Task 11 — library and playlists',
  podcasts: 'Task 12 — podcasts',
  creators: 'Task 13 — creators and uploads',
  user: 'Task 15 — user and recommendations',
} as const;

export type OwningTask = keyof typeof OWNING_TASKS;

/**
 * Every Mongoose model a hybrid catalog service is still allowed to import,
 * mapped to the task that will remove it.
 *
 * A model NOT in here cannot be registered against any file — which is what
 * stops the registry becoming a general-purpose "this import is fine" list.
 */
export const NON_CATALOG_MODEL_OWNERS = {
  Library: 'library',
  Playlist: 'library',
  PlaylistTrack: 'library',
  ArtistClaim: 'creators',
  ContributionAttestation: 'creators',
  UserUpload: 'creators',
  Episode: 'podcasts',
  Podcast: 'podcasts',
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
    models: ['CatalogRelation', 'Library', 'UserTasteProfile'],
    reason:
      'Builds fixtures for both databases. The catalogue half is drizzle; the co-listen graph ' +
      'and taste weights belong to Task 15 and the library to Task 11.',
  },
  {
    file: 'services/radio/radioSeed.ts',
    models: ['Library', 'UserTasteProfile'],
    reason:
      'The user seed reads taste weights (Task 15) and liked tracks (Task 11), then hands a ' +
      'list of track ids to a Postgres query. The PLAYLIST seed is already drizzle — Task 10a ' +
      'put `playlists`/`playlist_tracks` on that side in `containers.ts`, and leaving this one ' +
      'on Mongoose made two catalog services disagree about where a playlist lives.',
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
    models: ['CatalogRelation', 'Library', 'ListeningEvent', 'UserTasteProfile'],
    reason:
      'Every personalised read starts from a taste profile, a library and a listening history ' +
      '(Tasks 11 and 15) and ends in a Postgres catalog query keyed on the ids they return.',
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
    file: 'controllers/entityProfile.controller.ts',
    models: ['Episode', 'Podcast'],
    reason:
      'The `appearsIn` shelf is entirely podcasts — shows and episodes crediting a person, ' +
      'matched by `strongKeyCreditMatch`. Task 12\'s vertical end to end; the catalogue half ' +
      'of the same handler is drizzle, and the two never meet in one query.',
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
  readonly owner: string;
  readonly reason: string;
}[] = [
  {
    file: 'services/podcasts/resolvePersons.ts',
    models: ['CatalogEntity'],
    owner: 'Task 12',
    reason:
      'A SCOPE constraint, not a capability one: `podcast_persons` and `episode_persons` exist ' +
      'today (`schema/podcasts.ts`), so `strongKeyCreditMatch` CAN be expressed in drizzle — ' +
      'doing it means writing podcast reads, which is Task 12\'s territory, not 10c\'s.',
  },
  // `services/uploads/{acoustid,isrcLookup,provenanceSignals}.ts` were listed
  // here — missed by the Task 10b brief's selector, which keyed on four model
  // names while `schema/catalog.ts` owns nineteen tables. They are ported now,
  // and this gate is what said so: all three failed the "still imports what it
  // is listed for" assertion the moment the imports went, which is the stale
  // direction firing on real work rather than on a fixture.
] as const;
