import type { Decision, RecommendedAction, Severity } from '@oxyhq/crowdsource-contracts';
import type { ModerationEnforcementAction } from '../models/ModerationEnforcement';

/**
 * Deciding what Syra will do about a decision — and nothing else.
 *
 * Pure: no database, no clock, no configuration. A decision in, a plan out. That
 * is what makes the mapping testable as a table rather than as an integration
 * scenario, and it is why `observe` mode is a real audit rather than a comment —
 * the plan is computed identically in every mode and only its EXECUTION is gated.
 *
 * ## Syra maps recommendations, not findings
 *
 * The jury classified the material and the consensus engine turned that into a
 * recommendation under a versioned policy (§7.6). An application that re-derived
 * its action from raw severity would be quietly re-deciding the case with a
 * second, unversioned policy of its own — and the two would diverge the first time
 * CrowdSource's policy was updated. Severity is a fallback only, for a `violation`
 * that arrives with no recommendation at all, because a violation Syra did nothing
 * about would be worse than a mapped one.
 *
 * ## Syra has ONE content lever, and that shapes everything below
 *
 * `restrict` is the whole of it: a track or album leaves the catalog
 * (`isAvailable: false`), a playlist or house stops being public (`visibility`),
 * a room changes lifecycle `status`. `restore` puts back exactly what was there,
 * read off the row that changed it.
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
 * from the catalog, which is enormously STRONGER than any of them. §7.6 lets an
 * application refuse or adapt a recommendation provided it records what it did,
 * so all four become `manual_review`: recorded, visible, and honest about needing
 * a person. A declined recommendation must never look like one that never
 * arrived — and on this platform it must never be silently upgraded into a
 * takedown either.
 *
 * `suspend_user` is Oxy's to carry out, not Syra's; `legal_queue` needs a human.
 * Same treatment, same reason.
 */

export interface PlannedEnforcementAction {
  readonly action: ModerationEnforcementAction;
  /** Why, in words an operator reads. Never reported material. */
  readonly reason: string;
  /** The recommendation this came from, when it came from one. */
  readonly recommendedAction?: RecommendedAction;
}

/** What a recommended action becomes in Syra. */
const RECOMMENDATION_TO_ACTION: Readonly<
  Record<RecommendedAction, ModerationEnforcementAction>
> = Object.freeze({
  remove: 'restrict',
  remove_or_restrict: 'restrict',
  hide: 'restrict',


  allow: 'none',
  no_action: 'none',
  no_global_effect: 'none',
  restore: 'restore',

  // Syra can display no warning and has no distribution dial. Recorded for a
  // human rather than silently UPGRADED into the only effect it does have, which
  // is removal from the catalog.
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
});

/**
 * The action a violation gets when the decision recommended nothing.
 *
 * Severity only, and deliberately cautious at both ends. A `low`-severity
 * violation with no recommendation is not something to remove somebody's work
 * over, so it goes to a human; `critical` goes to a human too, because §7.5 routes
 * that material to a specialist team under legal protocol and an automatic removal
 * driven by a webhook is not that. The difference between them is a policy decision
 * with legal weight, and a mapping table is the wrong place to make it.
 */
const SEVERITY_FALLBACK: Readonly<Record<Severity, ModerationEnforcementAction>> =
  Object.freeze({
    critical: 'manual_review',
    high: 'restrict',
    // No middle lever exists, so anything below `high` asks a person rather
    // than reaching for the only tool available, which is removal.
    medium: 'manual_review',
    low: 'manual_review',
  });

const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

function highestSeverity(decision: Decision): Severity | undefined {
  let highest: Severity | undefined;
  for (const finding of decision.findings) {
    if (
      highest === undefined ||
      SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(highest)
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

/**
 * `no_violation` always carries a restore, whatever it recommended.
 *
 * This exists because of a failure that is very easy to ship and very hard to see.
 * A correction is a new revision whose outcome is `no_violation`, and its
 * recommendation is frequently `no_action` — which is CrowdSource saying "take no
 * NEW action", not "leave what you already did in place". Mapping that straight
 * through plans `none`, and the playlist an earlier revision hid stays
 * hidden forever: the appeal succeeded, the case says the listing was fine,
 * and nothing in Syra ever puts it back. No error, no log line, no failing test
 * anywhere else.
 *
 * §7.6 lists `allow`, `restore` and `no_action` together as the application's
 * options for `no_violation` precisely because choosing between them needs
 * knowledge only the application has — whether it did something earlier. So the
 * plan always includes the restore, and the executor records "there was nothing to
 * undo" when that is the case, which is evidence rather than a silent no-op.
 */
function withRestoreForNoViolation(
  decision: Decision,
  planned: readonly PlannedEnforcementAction[],
): readonly PlannedEnforcementAction[] {
  if (decision.outcome !== 'no_violation') return planned;
  if (planned.some((entry) => entry.action === 'restore')) return planned;
  return [
    ...planned,
    { action: 'restore', reason: 'No violation: undo any earlier enforcement' },
  ];
}

/**
 * Collapse a plan to the actions that can coexist.
 *
 * A decision may recommend both removal and a note for a human; recording
 * `restrict` alongside `none` or `restore` would claim two contradictory effects
 * where one happened. `restrict` therefore absorbs `none` and `restore`, and
 * `none` never survives alongside anything else. `manual_review` always survives —
 * it is a note for a human, and dropping it because something else was also done
 * is how a `suspend_user` recommendation gets lost.
 */
function collapse(
  actions: readonly PlannedEnforcementAction[],
): PlannedEnforcementAction[] {
  const byAction = new Map<ModerationEnforcementAction, PlannedEnforcementAction>();
  for (const planned of actions) {
    if (!byAction.has(planned.action)) byAction.set(planned.action, planned);
  }

  if (byAction.has('restrict')) {
    byAction.delete('none');
    byAction.delete('restore');
  }
  if (byAction.size > 1) byAction.delete('none');

  return Array.from(byAction.values());
}

/**
 * What Syra will do about this decision.
 *
 * Never empty: a decision that produces no action produces an explicit `none`,
 * because a row saying "we decided to do nothing, and why" is evidence and an
 * absent row is a question.
 */
export function planEnforcement(decision: Decision): PlannedEnforcementAction[] {
  const fromRecommendations = decision.recommendedActions.map(
    (recommended): PlannedEnforcementAction => ({
      action: RECOMMENDATION_TO_ACTION[recommended.action] ?? 'manual_review',
      reason: `CrowdSource recommended ${recommended.action}`,
      recommendedAction: recommended.action,
    }),
  );

  if (fromRecommendations.length > 0) {
    const collapsed = collapse(withRestoreForNoViolation(decision, fromRecommendations));
    return collapsed.length > 0
      ? collapsed
      : [{ action: 'none', reason: 'No recommended action maps to a Syra effect' }];
  }

  switch (decision.outcome) {
    case 'violation': {
      const severity = highestSeverity(decision);
      /**
       * A `violation` with no findings cannot happen — the contract refuses it —
       * so an absent severity here means a newer CrowdSource sent something this
       * code has not seen. A human looks at it rather than a default removing
       * somebody's work from the catalog.
       */
      if (severity === undefined) {
        return [
          {
            action: 'manual_review',
            reason: 'Violation carried no finding severity this version understands',
          },
        ];
      }
      return [
        {
          action: SEVERITY_FALLBACK[severity],
          reason: `Violation with no recommended action, highest severity ${severity}`,
        },
      ];
    }

    case 'no_violation':
      /**
       * A restore, always planned — even when nothing was enforced. The executor
       * records it as not applied with the reason, which is how "we checked and
       * there was nothing to undo" is distinguishable from "we never looked".
       */
      return [{ action: 'restore', reason: 'No violation: undo any earlier enforcement' }];

    case 'insufficient_context':
    case 'inconclusive':
    case 'escalated':
      /**
       * §7.6 offers `keep_restricted_temporarily`, `escalate` and internal review
       * for these. None of them is "remove", and none is "it was fine": absence of
       * consensus is neither guilt nor innocence, so Syra changes nothing on its
       * own and asks a human.
       */
      return [
        {
          action: 'manual_review',
          reason: `Outcome ${decision.outcome}: no automatic action, internal review`,
        },
      ];

    case 'content_unavailable':
    case 'duplicate':
      return [{ action: 'none', reason: `Outcome ${decision.outcome}: nothing to enforce` }];

    default:
      /**
       * An outcome §9.6 does not currently define. §10.11 requires a newer server
       * not to break an older client, and the safe reading of an unknown outcome
       * is a human, never a default effect.
       */
      return [
        {
          action: 'manual_review',
          reason: 'Decision outcome not recognised by this version of Syra',
        },
      ];
  }
}
