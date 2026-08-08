import {
  createModerationIntegration,
  type ModerationIntegration,
  type ModerationReportFields,
  type ModerationTaxonomy,
} from '@oxyhq/crowdsource-app';
import { postgresModerationStore } from '@oxyhq/crowdsource-app/postgres';
import type { Decision } from '@oxyhq/crowdsource-contracts';
import { getDb } from '../db/postgres';
import { moderationTableSet, reports } from '../db/schema/moderation';
import { logger } from '../utils/logger';
import { crowdSourceConfig } from './config';
import { SYRA_ENFORCEMENT } from './enforcement';
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from './report-taxonomy';
import { legacyStatusForOutcome } from './report-status';
import { SYRA_SUBJECT_PROVIDERS } from './subjects/providers';
import type { ModerationEnforcementAction, ReportStatus } from './types';

/**
 * Syra's CrowdSource integration, wired once.
 *
 * Nearly everything that used to be in this directory is now imported. The
 * transactional outbox, delivery with retries and dead-lettering, the webhook
 * receiver, cross-instance deduplication, decision application with a revision
 * guard, the enforcement claim and the planning algorithm are identical in every
 * application that adopts CrowdSource, and they live in
 * `@oxyhq/crowdsource-app`. Syra supplies four things — its subject providers,
 * its category→allegation mapping, its enforcement config, and the store built
 * over its own tables — and this file hands them over.
 *
 * ## Lazily built, and that is not an optimisation
 *
 * `getDb()` throws before `connectPostgres()` has run, and `crowdSourceConfig()`
 * is deliberately re-derivable rather than frozen at first import. A
 * module-level integration would therefore either crash at import or capture a
 * configuration a test has since reset. The factory shape the package chose —
 * everything from one object, nothing at module scope — is what lets this be one
 * lazy singleton rather than a dozen.
 */

/**
 * Syra's report row, as the package's ports see it.
 *
 * Declared rather than derived from `typeof reports.$inferSelect`, which is the
 * shape the package's own suites use for the same reason: drizzle types a
 * nullable column `string | null` while the port declares `details?: string`,
 * and the Postgres store already normalises every optional field back to ABSENT
 * on the way out — exhaustively, by type rather than by list. Deriving the type
 * from the table would describe the column and not the value the store returns.
 *
 * `status` is the one field the package knows nothing about: Syra's verdict axis,
 * which existed before it adopted CrowdSource.
 */
export interface SyraReport extends ModerationReportFields {
  status: ReportStatus;
}

/**
 * What Syra reports, as universal allegations, and what it declares about the
 * evidence it can carry.
 *
 * Exported so the declaration is ASSERTABLE. It is one property of one object
 * three layers below a request, and nothing else in Syra would notice it going
 * absent — `moderationTaxonomy.test.ts` is what makes deleting it fail rather
 * than ship.
 */
export const SYRA_TAXONOMY: ModerationTaxonomy = {
  version: REPORT_TAXONOMY_VERSION,
  allegationsFor: allegationsForCategories,
  /**
   * Declared, because it cannot yet be attached.
   *
   * An agent's avatar is a bare string with no digest recorded anywhere — see
   * `subjects/providers.ts` — so a jury can see that material exists which it
   * was not given. Saying so lets it answer `insufficient_context` for the
   * right reason instead of guessing, and a jury guessing is a decision-quality
   * problem that fails nothing and alerts nobody.
   *
   * Syra carried this before it adopted the package; 0.5.0 had no hook for it
   * and the adoption dropped it. `taxonomy.metadata` (0.6.0) is that hook, and
   * it merges UNDER the package's own `taxonomyVersion` and `categories`, so
   * this cannot shadow either.
   */
  metadata: { evidenceAttachmentsSupported: false },
};

let integration: ModerationIntegration<SyraReport, ModerationEnforcementAction> | null = null;
let store: ReturnType<typeof postgresModerationStore<SyraReport>> | null = null;

function getStore(): ReturnType<typeof postgresModerationStore<SyraReport>> {
  store ??= postgresModerationStore<SyraReport>({
    db: getDb(),
    reportTable: reports,
    tables: moderationTableSet,
  });
  return store;
}

/**
 * Prove the four tables resolve, before the first report is filed.
 *
 * The Postgres store CREATES nothing — the migration did — so what
 * `ensureSchema` does here is parse and plan one statement per table without
 * reading a row. A missing table raises `42P01` and names it, at boot, rather
 * than at the first delivery hours later. It cannot check columns; a column
 * missing from the spread is a compile error and a stale migration is a `42703`,
 * both loud, neither this function's job.
 */
export async function assertModerationSchema(): Promise<void> {
  await getStore().ensureSchema();
}

/**
 * Both status axes for a decided report, derived in ONE place.
 *
 * `localStatus` is the package's — "did it get out of here and come back" — and
 * it writes that itself. `status` is Syra's verdict axis and reaches the same
 * update through this hook, which exists in the package for exactly this case: an
 * application that already had a verdict field before it adopted CrowdSource.
 *
 * Two status fields maintained by two call sites is how they drift, so this is
 * the only writer of `status` after intake, and intake needs no hook at all
 * because the column's own default says `pending`.
 */
function reportDecisionExtraFields(decision: Decision): { status: ReportStatus } {
  return { status: legacyStatusForOutcome(decision.outcome) };
}

export function getModerationIntegration(): ModerationIntegration<
  SyraReport,
  ModerationEnforcementAction
> {
  /**
   * No explicit type arguments. All three are inferred — `TReport` and `TTx`
   * from the store, `TAction` from the enforcement config — which is the
   * property that makes the integration backend-agnostic: a caller holding one
   * cannot tell which store built it.
   */
  integration ??= createModerationIntegration({
    store: getStore(),
    crowdSource: crowdSourceConfig(),
    subjects: SYRA_SUBJECT_PROVIDERS,
    taxonomy: SYRA_TAXONOMY,
    enforcement: SYRA_ENFORCEMENT,
    logger,
    reportDecisionExtraFields,
  });
  return integration;
}

/** Test hook. Production builds the integration once and keeps it. */
export function resetModerationIntegration(): void {
  integration = null;
  store = null;
}
