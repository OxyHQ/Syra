import mongoose from 'mongoose';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import { PlaylistVisibility } from '@syra/shared-types';
import { PlaylistModel } from '../models/Playlist';
import HouseModel from '../models/House';
import RoomModel from '../models/Room';
import { TrackModel } from '../models/Track';
import { ReportedType } from '../models/Report';
import {
  ModerationEnforcementModel,
  type IModerationEnforcement,
  type ModerationEnforcementAction,
  type ModerationPreviousState,
} from '../models/ModerationEnforcement';
import { crowdSourceConfig, type ModerationEnforcementMode } from './config';
import { planEnforcement, type PlannedEnforcementAction } from './enforcement-plan';
import { logger } from '../utils/logger';

/**
 * Carrying out a decision, exactly once.
 *
 * **Once.** Appendix D's key is `decisionId + revision + action`, and the unique
 * index on `ModerationEnforcement` is that key. Each action CLAIMS its row before
 * doing anything; a second attempt — a redelivered webhook, a reclaimed outbox
 * lease, a manual replay — loses the insert and does nothing.
 *
 * **Reversibly.** Every action that changes state records what the state WAS, and
 * a reversal puts that back. A playlist that was already private before anyone
 * reported it must not be made public by a correction.
 *
 * **And never as a copyright strike.** Nothing here touches `copyrightRemoved` or
 * `strikeService`. A DMCA takedown carries statutory consequences and is
 * irreversible by design; community moderation reaches `isAvailable`,
 * `visibility` and `status` only, so a jury can never manufacture a strike and
 * every action here can be undone.
 *
 * `observe` mode runs all of this except the effect: the plan, the claim and the
 * record are identical to production, so the mode proves exactly what will happen
 * when it is switched off.
 */

export interface EnforcementSubject {
  /** Syra's own noun (`playlist`, `house`, `artist`, `track`, `room`). */
  type: string;
  id: string;
}

export interface EnforcementOutcome {
  action: ModerationEnforcementAction;
  /**
   * `applied` — the effect happened. `recorded` — claimed and deliberately not
   * carried out (observe/manual mode, or nothing to do). `duplicate` — another
   * delivery of this same decision revision already handled it.
   */
  result: 'applied' | 'recorded' | 'duplicate';
}

type EffectResult =
  | { changed: true; previousState: ModerationPreviousState }
  | { changed: false; reason: string };

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code?: unknown }).code) === 11000
  );
}

/** The most recent APPLIED action of a kind against this subject. */
async function lastApplied(
  subject: EnforcementSubject,
  action: ModerationEnforcementAction,
): Promise<Pick<IModerationEnforcement, 'previousState'> | null> {
  return await ModerationEnforcementModel.findOne({
    subjectType: subject.type,
    subjectId: subject.id,
    action,
    applied: true,
  })
    .sort({ createdAt: -1 })
    .lean<Pick<IModerationEnforcement, 'previousState'> | null>();
}

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
async function restrict(subject: EnforcementSubject): Promise<EffectResult> {
  if (!mongoose.isValidObjectId(subject.id)) {
    return { changed: false, reason: 'The reported object no longer exists' };
  }

  switch (subject.type) {
    case ReportedType.TRACK: {
      const track = await TrackModel.findById(subject.id)
        .select('isAvailable')
        .lean<{ isAvailable?: boolean } | null>();
      if (!track) return { changed: false, reason: 'The reported track no longer exists' };
      if (track.isAvailable === false) {
        return { changed: false, reason: 'The track was already out of the catalog' };
      }
      // `copyrightRemoved` is deliberately untouched — see the file header.
      await TrackModel.updateOne({ _id: subject.id }, { $set: { isAvailable: false } });
      return { changed: true, previousState: { isAvailable: true } };
    }

    case ReportedType.PLAYLIST: {
      const playlist = await PlaylistModel.findById(subject.id)
        .select('visibility')
        .lean<{ visibility?: string } | null>();
      if (!playlist) {
        return { changed: false, reason: 'The reported playlist no longer exists' };
      }
      if (playlist.visibility !== PlaylistVisibility.PUBLIC) {
        return { changed: false, reason: 'The playlist was already not public' };
      }
      await PlaylistModel.updateOne(
        { _id: subject.id },
        { $set: { visibility: PlaylistVisibility.PRIVATE } },
      );
      return { changed: true, previousState: { visibility: PlaylistVisibility.PUBLIC } };
    }

    case ReportedType.HOUSE: {
      const house = await HouseModel.findById(subject.id)
        .select('visibility')
        .lean<{ visibility?: { discovery?: string } } | null>();
      if (!house) return { changed: false, reason: 'The reported house no longer exists' };
      const discovery = house.visibility?.discovery;
      if (discovery === 'hidden') {
        return { changed: false, reason: 'The house was already hidden' };
      }
      await HouseModel.updateOne(
        { _id: subject.id },
        { $set: { 'visibility.discovery': 'hidden' } },
      );
      return {
        changed: true,
        previousState: { visibility: discovery ?? 'public' },
      };
    }

    case ReportedType.ROOM: {
      const room = await RoomModel.findById(subject.id)
        .select('archived')
        .lean<{ archived?: boolean } | null>();
      if (!room) return { changed: false, reason: 'The reported room no longer exists' };
      if (room.archived === true) {
        return { changed: false, reason: 'The room was already archived' };
      }
      await RoomModel.updateOne({ _id: subject.id }, { $set: { archived: true } });
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
 * Read off the enforcement row that made the change rather than reset to a
 * hardcoded default: a playlist that was private before anybody reported it must
 * not become public because a correction arrived.
 */
async function restore(subject: EnforcementSubject): Promise<EffectResult> {
  const restriction = await lastApplied(subject, 'restrict');
  if (!restriction?.previousState) {
    return { changed: false, reason: 'There was no earlier restriction to undo' };
  }
  if (!mongoose.isValidObjectId(subject.id)) {
    return { changed: false, reason: 'The reported object no longer exists' };
  }
  const previous = restriction.previousState;

  switch (subject.type) {
    case ReportedType.TRACK: {
      if (previous.isAvailable !== true) {
        return { changed: false, reason: 'The track was not available before the restriction' };
      }
      const result = await TrackModel.updateOne(
        { _id: subject.id },
        { $set: { isAvailable: true } },
      );
      if (result.matchedCount === 0) {
        return { changed: false, reason: 'The reported track no longer exists' };
      }
      return { changed: true, previousState: { isAvailable: false } };
    }

    case ReportedType.PLAYLIST: {
      if (previous.visibility === undefined) {
        return { changed: false, reason: 'No previous playlist visibility was recorded' };
      }
      const result = await PlaylistModel.updateOne(
        { _id: subject.id },
        { $set: { visibility: previous.visibility } },
      );
      if (result.matchedCount === 0) {
        return { changed: false, reason: 'The reported playlist no longer exists' };
      }
      return { changed: true, previousState: { visibility: PlaylistVisibility.PRIVATE } };
    }

    case ReportedType.HOUSE: {
      if (previous.visibility === undefined) {
        return { changed: false, reason: 'No previous house visibility was recorded' };
      }
      const result = await HouseModel.updateOne(
        { _id: subject.id },
        { $set: { 'visibility.discovery': previous.visibility } },
      );
      if (result.matchedCount === 0) {
        return { changed: false, reason: 'The reported house no longer exists' };
      }
      return { changed: true, previousState: { visibility: 'hidden' } };
    }

    case ReportedType.ROOM: {
      const result = await RoomModel.updateOne(
        { _id: subject.id },
        { $set: { archived: false } },
      );
      if (result.matchedCount === 0) {
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

async function applyEffect(
  action: ModerationEnforcementAction,
  subject: EnforcementSubject,
): Promise<EffectResult> {
  switch (action) {
    case 'none':
    case 'manual_review':
      return { changed: false, reason: `Action '${action}' has no effect by definition` };
    case 'restrict':
      return await restrict(subject);
    case 'restore':
      return await restore(subject);
  }
}

/**
 * Whether the current mode allows this action to actually happen.
 *
 * `observe` allows nothing — that is the mode. `manual` allows only `restore`:
 * putting something back gives it BACK, and holding that behind a human review
 * means a wrongly-removed track stays removed while somebody reads a queue.
 * Taking anything down still waits for a person. `automatic` allows the mapped
 * set.
 */
function modeAllows(
  mode: ModerationEnforcementMode,
  action: ModerationEnforcementAction,
): boolean {
  switch (mode) {
    case 'observe':
      return false;
    case 'manual':
      return action === 'restore';
    case 'automatic':
      return true;
  }
}

export interface ApplyDecisionEnforcementInput {
  decision: Decision;
  caseId: string;
  subject: EnforcementSubject;
  /** Defaults to the configured mode. Explicit in tests. */
  mode?: ModerationEnforcementMode;
}

/** Plan and carry out everything this decision revision asks for. */
export async function applyDecisionEnforcement(
  input: ApplyDecisionEnforcementInput,
): Promise<EnforcementOutcome[]> {
  const mode = input.mode ?? crowdSourceConfig().enforcementMode;
  const plan = planEnforcement(input.decision);
  const outcomes: EnforcementOutcome[] = [];

  for (const planned of plan) {
    outcomes.push(await applyOne(planned, input, mode));
  }
  return outcomes;
}

async function applyOne(
  planned: PlannedEnforcementAction,
  input: ApplyDecisionEnforcementInput,
  mode: ModerationEnforcementMode,
): Promise<EnforcementOutcome> {
  const { decision, caseId, subject } = input;

  /**
   * The claim. The unique index refuses a second row for this
   * `decisionId + revision + action`, so losing this insert is the answer
   * "another delivery already handled it" and not an error.
   */
  let record: IModerationEnforcement;
  try {
    record = await ModerationEnforcementModel.create({
      decisionId: decision.id,
      decisionRevision: decision.revision,
      action: planned.action,
      caseId,
      subjectType: subject.type,
      subjectId: subject.id,
      outcome: decision.outcome,
      ...(planned.recommendedAction === undefined
        ? {}
        : { recommendedAction: planned.recommendedAction }),
      reason: planned.reason,
      mode,
      applied: false,
    });
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return { action: planned.action, result: 'duplicate' };
    }
    throw error;
  }

  if (!modeAllows(mode, planned.action)) {
    await ModerationEnforcementModel.updateOne(
      { _id: record._id },
      {
        $set: {
          skippedReason:
            mode === 'observe'
              ? 'observe mode: recorded, not applied'
              : `${mode} mode does not apply '${planned.action}' automatically`,
        },
      },
    );
    return { action: planned.action, result: 'recorded' };
  }

  try {
    const effect = await applyEffect(planned.action, subject);
    if (!effect.changed) {
      await ModerationEnforcementModel.updateOne(
        { _id: record._id },
        { $set: { skippedReason: effect.reason } },
      );
      return { action: planned.action, result: 'recorded' };
    }

    await ModerationEnforcementModel.updateOne(
      { _id: record._id },
      {
        $set: {
          applied: true,
          appliedAt: new Date(),
          previousState: effect.previousState,
        },
      },
    );
    return { action: planned.action, result: 'applied' };
  } catch (error: unknown) {
    /**
     * The claim goes back so a retry can try again. Keeping it would make a
     * transient failure permanent: the action would be deduplicated away forever
     * and the decision would silently never be carried out.
     */
    await ModerationEnforcementModel.deleteOne({ _id: record._id });
    logger.error('[CrowdSource] enforcement effect failed, claim released', {
      decisionId: decision.id,
      revision: decision.revision,
      action: planned.action,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
