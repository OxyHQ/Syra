/**
 * The closed value sets of Syra's moderation vertical.
 *
 * These were members of `models/Report.ts` and `models/ModerationEnforcement.ts`
 * until this task deleted both files. They live here rather than in
 * `@syra/shared-types` for the same reason `db/rooms/types.ts` gives: nothing
 * outside this backend consumes them.
 *
 * ## One expression, not two
 *
 * `db/rooms/types.ts` keeps its enums BESIDE the schema's `as const` tuples and
 * pins the two together with a test, because ~60 call sites read
 * `RoomStatus.LIVE`. Here the enums are the only expression: `schema/moderation.ts`
 * derives its CHECK constraints from `Object.values()` of these very enums, so a
 * value added to one is a value added to both and there is nothing to pin.
 *
 * That is possible here and was not there because the tuples reach the schema
 * through `@oxyhq/crowdsource-app/postgres`'s `moderationReportColumnOptions`,
 * which takes `readonly string[]` — an enum's values satisfy it directly.
 */

/**
 * What Syra will accept a report ABOUT.
 *
 * Wider than what it can DELIVER, and deliberately so — see `subjects/registry.ts`.
 * A type with a subject provider is sent for community review; a type without one
 * is stored with the reason and never leaves.
 */
export enum ReportedType {
  /** A user's public playlist. */
  PLAYLIST = 'playlist',
  /** A user-created house (community). */
  HOUSE = 'house',
  /** A Syra artist profile. */
  ARTIST = 'artist',
  /** A track in the catalog. */
  TRACK = 'track',
  /** A live or ended audio room. */
  ROOM = 'room',
  /**
   * A mirrored podcast show. Accepted, never delivered — see the registry: the
   * publisher is a third party outside Syra with no Oxy identity.
   */
  PODCAST = 'podcast',
  /** A mirrored podcast episode. Accepted, never delivered, same reason. */
  EPISODE = 'episode',
  /**
   * A listener's account. Accepted, never delivered — Oxy owns identity and a
   * plain listener has no Syra-side profile to snapshot. (An ARTIST does, which is
   * why that one is deliverable and this one is not.)
   */
  USER = 'user',
}

/**
 * What the reporter says is wrong.
 *
 * No `copyright` value, on purpose. `CopyrightReport` plus `strikeService` is a
 * real DMCA pipeline and stays separate: the universal taxonomy contains no
 * copyright, infringement or IP code at all, which is the contract declining the
 * question rather than overlooking it. A community vote must never be able to
 * produce something that looks like a strike but carries none of the statutory
 * process one legally requires.
 */
export enum ReportCategory {
  SPAM = 'spam',
  HARASSMENT = 'harassment',
  HATE_SPEECH = 'hate_speech',
  EXPLICIT_CONTENT = 'explicit_content',
  IMPERSONATION = 'impersonation',
  VIOLENCE = 'violence',
  OTHER = 'other',
}

/**
 * What a jury concluded. `PENDING` until one has.
 *
 * Syra's SECOND status axis, and the one `@oxyhq/crowdsource-app` knows nothing
 * about — the package owns `localStatus` ("did it get out of here and come
 * back"), which is a different question. Both are maintained from one place:
 * `localStatus` by the package, this one by `legacyStatusForOutcome` through the
 * integration's `reportDecisionExtraFields` hook, which exists for exactly this
 * case — an application that already had a verdict field before it adopted
 * CrowdSource.
 */
export enum ReportStatus {
  PENDING = 'pending',
  REVIEWED = 'reviewed',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

/**
 * The two things Syra can actually do to a published object, reversibly, plus
 * the two that are notes rather than effects.
 *
 * Deliberately NOT a copy of another application's vocabulary. Syra has neither a
 * content warning nor an editorial promotion flag, so there is no
 * `label_sensitive` and no `demote` — recording an effect that did not happen
 * would be worse than mapping honestly.
 *
 * `restrict` is deliberately NOT the copyright takedown. That path sets
 * `copyrightRemoved` (plus `isAvailable: false`) and is irreversible by design,
 * because a DMCA strike carries statutory consequences. Community moderation
 * touches `isAvailable` / `visibility` / `status` only, so a jury can never
 * manufacture a copyright strike and a `restore` can always put the object back.
 */
export type ModerationEnforcementAction = 'restrict' | 'restore' | 'manual_review' | 'none';

/**
 * Every action, STRONGEST FIRST.
 *
 * The order is load-bearing twice over, which is why it is stated once here and
 * read rather than restated. `ModerationEnforcementConfig.actions` types the
 * stored CHECK, and `precedence` defaults to `actions` — so this order also
 * decides the ONE action written onto a report when a plan produced several. A
 * state-changing action beats a note for a human, which beats an explicit
 * nothing, and `manual_review` still reaches the report because a reporter told
 * "nothing happened" when a human is about to look is being told something
 * untrue.
 */
export const MODERATION_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'restrict',
  'restore',
  'manual_review',
  'none',
];

/**
 * The fields an action replaced, so a reversal can put them back.
 *
 * Flat and explicit rather than an opaque blob: a reversal reads these, and a
 * shape nobody can typecheck is a shape that silently stops being restored. It
 * NARROWS the package's `EnforcementPreviousState`, which is deliberately open
 * (`Record<string, string | number | boolean | null | undefined>`) because the
 * package cannot know what an application's effects displace.
 *
 * **A `type`, not an `interface`, and that is not a style choice.** TypeScript
 * gives an object type alias an implicit index signature and an interface none,
 * so the interface this was under Mongoose is NOT assignable to the package's
 * `Record`-shaped port — `apply` returning one fails with "Index signature for
 * type 'string' is missing". The alias satisfies it structurally with nothing
 * asserted anywhere.
 *
 * `copyrightRemoved` is absent on purpose — community moderation never sets it,
 * so it never has one to restore.
 */
export type ModerationPreviousState = {
  isAvailable?: boolean;
  /** A playlist's or house's previous visibility token. */
  visibility?: string;
  /** A podcast's or room's previous lifecycle status. */
  status?: string;
};
