import { eq } from 'drizzle-orm';
import type {
  EnforcementEffect,
  ModerationEnforcementConfig,
} from '@oxyhq/crowdsource-app';
import { PlaylistVisibility, playlistVisibilitySchema } from '@syra/shared-types';
import { setHouseDiscovery, findHouseById } from '../db/rooms/houses';
import { findPublicRoomById, setRoomArchived } from '../db/rooms/rooms';
import { HouseDiscovery } from '../db/rooms/types';
import { getDb } from '../db/postgres';
import { tracks } from '../db/schema/catalog';
import { playlists } from '../db/schema/library';
import {
  MODERATION_ENFORCEMENT_ACTIONS,
  ReportedType,
  type ModerationEnforcementAction,
  type ModerationPreviousState,
} from './types';

/**
 * Syra's half of enforcement: what it can do about a decision, and how.
 *
 * The idempotency claim, the mode gate, the audit row, the reversal lookup and
 * the release-on-failure are `@oxyhq/crowdsource-app`'s and are not configurable
 * — they are the invariants rather than the policy. What is here is the policy:
 * four actions, the tables that map a CrowdSource recommendation onto them, and
 * one `apply` that carries them out.
 *
 * The planning ALGORITHM is the package's too, and that split is the one worth
 * understanding before adding a row below. Every application has different
 * actions, so the tables have to be its own; the algorithm must not be, because
 * it carries a correctness property that is invisible by construction — a
 * correction is a new revision whose outcome is `no_violation` and whose
 * recommendation is frequently `no_action`, which means "take no NEW action" and
 * not "leave what you already did in place". Mapping that straight through plans
 * nothing, and the playlist an earlier revision hid stays hidden forever: the
 * appeal succeeded, the case says the listing was fine, and nothing in Syra ever
 * puts it back. No error, no log line, no failing test. `restoreAction` is what
 * makes `no_violation` ALWAYS plan the restore, and it is the reason that field
 * is required rather than optional.
 *
 * ## Syra has ONE content lever, and that shapes every table below
 *
 * `restrict` is the whole of it: a track leaves the catalog (`isAvailable`), a
 * playlist or house stops being public (`visibility`), a room is archived.
 * `restore` puts back exactly what was there, read off the enforcement row that
 * changed it.
 *
 * **`restrict` is deliberately NOT the copyright takedown.** That path also sets
 * `copyrightRemoved`, feeds `strikeService`, and is irreversible because a DMCA
 * strike carries statutory consequences. Community moderation never touches it,
 * so a jury can never manufacture a strike and every action here can be undone.
 *
 * **There is no content-warning action and no promotion action, and adding
 * either would be a lie.** Syra renders no warning, no spoiler and no age gate,
 * and has no editorial promotion flag to withdraw. The tempting move is to fold
 * `label`, `allow_with_label`, `age_gate` and `reduce_distribution` into the
 * nearest available effect — but here the nearest available effect is removal
 * from the catalog, which is enormously STRONGER than any of them. An
 * application may refuse or adapt a recommendation provided it records what it
 * did, so all four become `manual_review`: recorded, visible, and honest about
 * needing a person. A declined recommendation must never look like one that never
 * arrived — and on this platform it must never be silently upgraded into a
 * takedown either.
 *
 * `suspend_user` is Oxy's to carry out, not Syra's; `legal_queue` needs a human.
 * Same treatment, same reason.
 */

type EffectResult = EnforcementEffect<ModerationEnforcementAction>;

/**
 * Take one object out of public reach, or explain why there was nothing to do.
 *
 * Each branch touches the field that noun's own read path already gates on, so a
 * restriction removes the object from listing, search and playback at once with
 * no query anywhere else to edit:
 *
 * - a track leaves the catalog through `isAvailable`, which is what
 *   `playableTrackFilter` and `isTrackPlayable` both check;
 * - a playlist stops being public through `visibility`, which `canViewPlaylist`
 *   is the single authority on;
 * - a house the same way, through its discovery axis;
 * - a room is archived, which is the only lever a room has that does not end a
 *   live session out from under the people in it.
 *
 * **An artist has no branch**, and that is deliberate rather than missing. The
 * levers an artist profile has — `terminated`, `uploadsDisabled` — belong to the
 * DMCA repeat-infringer path, and reaching for them here would let a community
 * decision produce something indistinguishable from a copyright termination
 * while carrying none of its process. A decision about an artist profile is
 * recorded and handed to a human.
 */
async function restrict(subject: { type: string; id: string }): Promise<EffectResult> {
  switch (subject.type) {
    case ReportedType.TRACK: {
      // No id-shape guard on ANY branch. Every id column this file reads is
      // `text`, so a malformed id matches no row and the query gives the same
      // answer a guard would — while an ObjectId-only guard, which is what this
      // function used to open with, rejected every uuid v7 id the catalogue has
      // minted since the cutover.
      const [track] = await getDb()
        .select({ isAvailable: tracks.isAvailable })
        .from(tracks)
        .where(eq(tracks.id, subject.id))
        .limit(1);
      if (!track) return { changed: false, reason: 'The reported track no longer exists' };
      if (track.isAvailable === false) {
        return { changed: false, reason: 'The track was already out of the catalog' };
      }
      // `copyrightRemoved` is deliberately untouched — see the file header.
      await getDb().update(tracks).set({ isAvailable: false }).where(eq(tracks.id, subject.id));
      return { changed: true, previousState: { isAvailable: true } };
    }

    case ReportedType.PLAYLIST: {
      const [playlist] = await getDb()
        .select({ visibility: playlists.visibility })
        .from(playlists)
        .where(eq(playlists.id, subject.id))
        .limit(1);
      if (!playlist) {
        return { changed: false, reason: 'The reported playlist no longer exists' };
      }
      if (playlist.visibility !== PlaylistVisibility.PUBLIC) {
        return { changed: false, reason: 'The playlist was already not public' };
      }
      await getDb()
        .update(playlists)
        .set({ visibility: PlaylistVisibility.PRIVATE })
        .where(eq(playlists.id, subject.id));
      return { changed: true, previousState: { visibility: PlaylistVisibility.PUBLIC } };
    }

    case ReportedType.HOUSE: {
      const house = await findHouseById(subject.id);
      if (!house) return { changed: false, reason: 'The reported house no longer exists' };
      const discovery = house.visibilityDiscovery;
      if (discovery === HouseDiscovery.HIDDEN) {
        return { changed: false, reason: 'The house was already hidden' };
      }
      await setHouseDiscovery(subject.id, HouseDiscovery.HIDDEN);
      /**
       * The recorded previous value is the column's own, with no `?? 'public'`
       * fallback: `visibility_discovery` is `notNull` with a default, so there
       * is no absent case to substitute for — and `'public'` was never one of
       * the axis's three values, so recording it would have written a state
       * `restore` below cannot put back.
       */
      return { changed: true, previousState: { visibility: discovery } };
    }

    case ReportedType.ROOM: {
      const room = await findPublicRoomById(subject.id);
      if (!room) return { changed: false, reason: 'The reported room no longer exists' };
      if (room.archived) {
        return { changed: false, reason: 'The room was already archived' };
      }
      await setRoomArchived(subject.id, true);
      return { changed: true, previousState: { status: 'unarchived' } };
    }

    default:
      return {
        changed: false,
        reason: `Syra has no reversible restriction for a reported ${subject.type}`,
      };
  }
}

/**
 * Put back exactly what a previous revision changed.
 *
 * `previousState` is handed in by the package, read off the most recent APPLIED
 * `restrict` row for this subject — which is what `reverses` below declares, and
 * why this function no longer queries the ledger itself. The `applied: true`
 * filter is the part that matters and is now in one place rather than
 * re-implemented per application: a reversal reading a row whose effect never
 * happened would restore a state nothing ever changed.
 *
 * Read off that row rather than reset to a hardcoded default, for the same
 * reason as before: a playlist that was private before anybody reported it must
 * not become public because a correction arrived.
 */
async function restore(
  subject: { type: string; id: string },
  previous: ModerationPreviousState | undefined,
): Promise<EffectResult> {
  if (!previous) {
    return { changed: false, reason: 'There was no earlier restriction to undo' };
  }

  switch (subject.type) {
    case ReportedType.TRACK: {
      if (previous.isAvailable !== true) {
        return { changed: false, reason: 'The track was not available before the restriction' };
      }
      // `returning()` rather than a row count: it is how drizzle answers
      // "did this match anything", the question `matchedCount` answered.
      const restored = await getDb()
        .update(tracks)
        .set({ isAvailable: true })
        .where(eq(tracks.id, subject.id))
        .returning({ id: tracks.id });
      if (restored.length === 0) {
        return { changed: false, reason: 'The reported track no longer exists' };
      }
      return { changed: true, previousState: { isAvailable: false } };
    }

    case ReportedType.PLAYLIST: {
      if (previous.visibility === undefined) {
        return { changed: false, reason: 'No previous playlist visibility was recorded' };
      }
      // `playlists.visibility` carries a CHECK constraint, where the Mongoose
      // enum was inert under `updateOne` — so a recorded value that is not a
      // real visibility used to be written back verbatim and is now refused.
      // Parsed rather than trusted, at the boundary of a row this process wrote
      // in an earlier revision and may not have written at all.
      const recorded = playlistVisibilitySchema.safeParse(previous.visibility);
      if (!recorded.success) {
        return { changed: false, reason: 'The recorded playlist visibility is not a real one' };
      }
      const restored = await getDb()
        .update(playlists)
        .set({ visibility: recorded.data })
        .where(eq(playlists.id, subject.id))
        .returning({ id: playlists.id });
      if (restored.length === 0) {
        return { changed: false, reason: 'The reported playlist no longer exists' };
      }
      return { changed: true, previousState: { visibility: PlaylistVisibility.PRIVATE } };
    }

    case ReportedType.HOUSE: {
      if (previous.visibility === undefined) {
        return { changed: false, reason: 'No previous house visibility was recorded' };
      }
      /**
       * Parsed rather than trusted, for the same reason the playlist branch
       * above parses its recorded visibility: `houses.visibility_discovery`
       * carries a CHECK constraint where the Mongoose enum was inert under
       * `updateOne`, so a recorded value that is not a real axis level used to
       * be written back verbatim and would now abort the transaction.
       */
      const recorded = Object.values(HouseDiscovery).find(
        (level) => level === previous.visibility,
      );
      if (recorded === undefined) {
        return { changed: false, reason: 'The recorded house visibility is not a real one' };
      }
      if (!(await setHouseDiscovery(subject.id, recorded))) {
        return { changed: false, reason: 'The reported house no longer exists' };
      }
      return { changed: true, previousState: { visibility: HouseDiscovery.HIDDEN } };
    }

    case ReportedType.ROOM: {
      if (!(await setRoomArchived(subject.id, false))) {
        return { changed: false, reason: 'The reported room no longer exists' };
      }
      return { changed: true, previousState: { status: 'archived' } };
    }

    default:
      return {
        changed: false,
        reason: `Syra has no reversible restriction for a reported ${subject.type}`,
      };
  }
}

export const SYRA_ENFORCEMENT: ModerationEnforcementConfig<ModerationEnforcementAction> = {
  /**
   * Strongest first, which is also `precedence` by default — see the tuple's own
   * comment in `types.ts` for why the order is load-bearing twice over.
   */
  actions: MODERATION_ENFORCEMENT_ACTIONS,
  noneAction: 'none',
  reviewAction: 'manual_review',

  /**
   * The action that DOES the undoing, never the one being undone.
   *
   * An inverted value here type-checks, plans, claims and then applies a
   * RESTRICTION on an accepted appeal — the correction carrying out the
   * punishment it was correcting. `assertRestoreDirection` refuses that at
   * construction by reading `reverses` below: its values are targets and its keys
   * are actors, so an action that appears only as a target has been declared by
   * someone reading the wrong column.
   */
  restoreAction: 'restore',

  /** What a `restore` needs the previous state of. */
  reverses: { restore: 'restrict' },

  /**
   * `manual` mode still applies a restore automatically.
   *
   * Putting something back gives it BACK, and holding that behind a human review
   * means a wrongly-removed track stays removed while somebody reads a queue.
   * Taking anything down still waits for a person.
   */
  reversibleActions: ['restore'],

  /** What a recommended action becomes in Syra. */
  recommendationToAction: {
    remove: 'restrict',
    remove_or_restrict: 'restrict',
    hide: 'restrict',

    allow: 'none',
    no_action: 'none',
    no_global_effect: 'none',
    restore: 'restore',

    // Syra can display no warning and has no distribution dial. Recorded for a
    // human rather than silently UPGRADED into the only effect it does have,
    // which is removal from the catalog.
    label: 'manual_review',
    allow_with_label: 'manual_review',
    age_gate: 'manual_review',
    reduce_distribution: 'manual_review',

    // Syra holds none of the levers these ask for. Recorded, queued for a human.
    suspend_user: 'manual_review',
    freeze_transaction: 'manual_review',
    request_changes: 'manual_review',
    request_more_context: 'manual_review',
    hold: 'manual_review',
    local_manual_review: 'manual_review',
    keep_restricted_temporarily: 'manual_review',
    escalate: 'manual_review',
    specialist_queue: 'manual_review',
    legal_queue: 'manual_review',
    safety_queue: 'manual_review',
  },

  /**
   * What a violation gets when the decision recommended nothing.
   *
   * Severity only, and deliberately cautious at both ends. A `low`-severity
   * violation with no recommendation is not something to remove somebody's work
   * over, so it goes to a human; `critical` goes to a human too, because that
   * material is routed to a specialist team under legal protocol and an automatic
   * removal driven by a webhook is not that. The difference between them is a
   * policy decision with legal weight, and a mapping table is the wrong place to
   * make it. `medium` has no middle lever to reach for, so it asks a person
   * rather than reaching for the only tool available.
   */
  severityFallback: {
    critical: 'manual_review',
    high: 'restrict',
    medium: 'manual_review',
    low: 'manual_review',
  },

  /**
   * A restricted object is not also restored, and does not also carry an explicit
   * "nothing". `manual_review` is never absorbed — it is a note for a human, and
   * dropping it because something else was also done is how a `suspend_user`
   * recommendation gets lost.
   */
  absorb: { restrict: ['none', 'restore'] },

  async apply(input) {
    switch (input.action) {
      case 'none':
      case 'manual_review':
        return { changed: false, reason: `Action '${input.action}' has no effect by definition` };
      case 'restrict':
        return await restrict(input.subject);
      case 'restore':
        return await restore(input.subject, input.previousState);
    }
  },
};
