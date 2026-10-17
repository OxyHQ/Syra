/**
 * Reconcile every Oxy reference entity type now (OxyHQ/oxy ADR 0043 D6) — the
 * nightly run, on demand, for an operator who has just moved data
 * (`migrate-images-to-oxy`, `migrate-audio-to-oxy`) and wants the counts.
 *
 * Preview by default: Oxy computes what it would add and remove and changes
 * nothing, and the preview is not recorded as a run (it would push the night's
 * real run a day out). `--apply` commits and is recorded like the nightly run.
 * Takes the nightly run's advisory lock: exit 2 while another run holds it.
 *
 *   bun run reconcile:oxy-file-references             # preview
 *   bun run reconcile:oxy-file-references -- --apply  # commit
 *
 * In production through `.github/workflows/run-backend-script.yml`
 * (`reconcile-oxy-file-references`); `docs/runbooks/oxy-files-images.md`
 * step 4 says when.
 */

import { closePostgres, connectPostgres } from '../db/postgres';
import { reconcileAllNow } from '../services/oxyFiles/referenceReconcile';
import { describeErrorSafely } from '../utils/error';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  await connectPostgres();
  try {
    const result = await reconcileAllNow(!apply);
    if (result === 'busy') {
      logger.warn('[reconcile-oxy-file-references] another run holds the lock; try again later');
      process.exitCode = 2;
      return;
    }
    for (const outcome of result.outcomes) {
      logger.info('[reconcile-oxy-file-references]', { ...outcome });
    }
    for (const failure of result.failed) {
      logger.error('[reconcile-oxy-file-references] failed', { ...failure });
    }
    const totals = result.outcomes.reduce(
      (sum, outcome) => ({
        added: sum.added + outcome.added,
        removed: sum.removed + outcome.removed,
        unchanged: sum.unchanged + outcome.unchanged,
        refused: sum.refused + outcome.refused,
      }),
      { added: 0, removed: 0, unchanged: 0, refused: 0 },
    );
    logger.info('[reconcile-oxy-file-references] done', {
      mode: apply ? 'apply' : 'preview',
      ...totals,
      failed: result.failed.length,
    });
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    logger.error('[reconcile-oxy-file-references] failed', { error: describeErrorSafely(error) });
    process.exit(1);
  });
}
