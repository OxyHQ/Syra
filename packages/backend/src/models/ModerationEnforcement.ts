import mongoose, { Document, Model, Schema } from 'mongoose';
import type { ModerationEnforcementMode } from '../moderation/config';

/**
 * What Syra did about a decision, once per decision revision per action.
 *
 * Appendix D's idempotency key is `decisionId + revision + action`, and the unique
 * compound index below IS that key. Every action CLAIMS its row before doing
 * anything, so a redelivered webhook, a reclaimed outbox lease or a manual replay
 * loses the insert and does nothing.
 *
 * `revision` is part of the key rather than a field beside it, and removing it
 * would be a silent, serious bug: a correction's `restore` is a DIFFERENT action
 * from the removal it supersedes, and collapsing them means an accepted appeal can
 * never put a playlist back in the catalog.
 *
 * Every state-changing action records what the state WAS, so a reversal restores
 * the real previous value rather than a guess at one — a playlist that was
 * already private before a report must not be made public by a correction.
 */

/**
 * The two things Syra can actually do to a published object, reversibly, plus
 * the two that are notes rather than effects.
 *
 * Deliberately NOT a copy of another application's vocabulary. Syra has neither a
 * content warning nor an editorial promotion flag, so there is no
 * `label_sensitive` and no `demote` — recording an effect that did not happen
 * would be worse than mapping honestly. See `moderation/enforcement-plan.ts`.
 *
 * `restrict` is deliberately NOT the copyright takedown. That path sets
 * `copyrightRemoved` (plus `isAvailable: false`) and is irreversible by design,
 * because a DMCA strike carries statutory consequences. Community moderation
 * touches `isAvailable` / `visibility` / `status` only, so a jury can never
 * manufacture a copyright strike and a `restore` can always put the object back.
 */
export type ModerationEnforcementAction =
  /** Take the object out of the catalog, or make it non-public. */
  | 'restrict'
  /** Undo what moderation previously did to this subject. */
  | 'restore'
  /** Recorded for a human. Never executed automatically. */
  | 'manual_review'
  /** An explicit, recorded decision to do nothing. */
  | 'none';

export const MODERATION_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  'restrict',
  'restore',
  'manual_review',
  'none',
];

/**
 * The fields an action replaced, so a reversal can put them back.
 *
 * Flat and explicit rather than a `Mixed` blob: a reversal reads these, and a
 * shape nobody can typecheck is a shape that silently stops being restored.
 *
 * `copyrightRemoved` is absent on purpose — community moderation never sets it,
 * so it never has one to restore.
 */
export interface ModerationPreviousState {
  isAvailable?: boolean;
  /** A playlist's or house's previous visibility token. */
  visibility?: string;
  /** A podcast's or room's previous lifecycle status. */
  status?: string;
}

export interface IModerationEnforcement extends Document {
  decisionId: string;
  decisionRevision: number;
  action: ModerationEnforcementAction;
  caseId: string;
  /** Syra's own noun (`playlist`, `house`, `artist`, `track`, `room`). */
  subjectType: string;
  subjectId: string;
  outcome: string;
  /** The CrowdSource recommendation this came from, when it came from one. */
  recommendedAction?: string;
  /** Why, in words an operator reads. Never reported material. */
  reason: string;
  mode: ModerationEnforcementMode;
  applied: boolean;
  appliedAt?: Date;
  /** Why a claimed action was deliberately not carried out. */
  skippedReason?: string;
  previousState?: ModerationPreviousState;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationEnforcementSchema = new Schema<IModerationEnforcement>(
  {
    decisionId: { type: String, required: true },
    decisionRevision: { type: Number, required: true },
    action: {
      type: String,
      enum: MODERATION_ENFORCEMENT_ACTIONS,
      required: true,
    },
    caseId: { type: String, required: true, index: true },
    subjectType: { type: String, required: true },
    subjectId: { type: String, required: true },
    outcome: { type: String, required: true },
    recommendedAction: { type: String },
    reason: { type: String, required: true, maxlength: 500 },
    mode: {
      type: String,
      enum: ['observe', 'manual', 'automatic'],
      required: true,
    },
    applied: { type: Boolean, default: false },
    appliedAt: { type: Date },
    skippedReason: { type: String, maxlength: 500 },
    previousState: {
      type: new Schema<ModerationPreviousState>(
        {
          isAvailable: { type: Boolean },
          visibility: { type: String },
          status: { type: String },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

/** Appendix D. This index is the idempotency guarantee, not an optimisation. */
ModerationEnforcementSchema.index(
  { decisionId: 1, decisionRevision: 1, action: 1 },
  { unique: true },
);
/** A reversal's lookup: the most recent applied action of a kind on a subject. */
ModerationEnforcementSchema.index({
  subjectType: 1,
  subjectId: 1,
  action: 1,
  applied: 1,
  createdAt: -1,
});

export const ModerationEnforcementModel: Model<IModerationEnforcement> =
  mongoose.models.ModerationEnforcement ||
  mongoose.model<IModerationEnforcement>(
    'ModerationEnforcement',
    ModerationEnforcementSchema,
    'moderation_enforcements',
  );
