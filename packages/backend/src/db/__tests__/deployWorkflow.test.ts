/**
 * `deploy-aws.yml` is the only thing that migrates production, and nothing
 * executes it before it runs against production.
 *
 * That is the whole reason this file exists. The workflow encodes three facts
 * that live in code elsewhere — which `--phase` spellings the migrator accepts,
 * which database the suite is tested against, and which of the two migration
 * paths a run takes — and each of them fails SILENTLY when the workflow drifts:
 * a bad phase is refused by the migrator at deploy time, a missing Postgres
 * service turns every deploy red in its first job, and a broken exclusivity
 * condition applies the journal twice. None of those is a test failure anywhere
 * else in this repo, because no test runs a workflow.
 *
 * ## The exclusivity is a property of the CONDITIONS, not of a convention
 *
 * `deploy-ecs-image.sh` takes its two one-shot commands from
 * `PRE_DEPLOY_TASK_COMMAND_JSON` / `POST_DEPLOY_TASK_COMMAND_JSON`, so the
 * workflow chooses between the cutover and the ordinary release by writing one
 * pair or the other into `$GITHUB_ENV` from two selector steps. Those steps
 * carry `if:` conditions that are COMPLEMENTS of the same expression, which is
 * what makes `--phase=all` and `--phase=post` unable to co-occur: not that
 * someone will remember, but that no run can execute both selectors.
 *
 * Two assertions are needed to hold that, and neither is redundant. The first
 * checks the conditions really are complements. The second checks the selectors
 * are the ONLY place those variables are set — because a hardcoded
 * `POST_DEPLOY_TASK_COMMAND_JSON` on the deploy step would be immune to every
 * `if:` in the file and would ride along with the cutover, which is the exact
 * shape this workflow had before the input existed.
 *
 * ## Why the cutover needs to be reachable at all
 *
 * `drizzle/` interleaves the two phases from 0001 onwards (0003 `pre` sits
 * behind 0001/0002 `post`), so against the EMPTY production ledger `pre` and
 * `post` both block — `planMigrationRun` refuses, by design, rather than leave a
 * hole. `all` is the only run that can perform the genesis apply. See
 * `src/db/migrate.ts`, "THE GENESIS BOOTSTRAP WINDOW". So `all` has to be
 * reachable (or the cutover cannot happen) and it has to be OPT-IN (or every
 * ordinary release applies deferred migrations while the previous image serves).
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATION_RUNS } from '@oxyhq/db/migrate';

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowFile {
  on: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; options?: string[] }>;
    };
  };
  jobs: Record<
    string,
    {
      'runs-on': string;
      env?: Record<string, string>;
      services?: Record<string, unknown>;
      steps: { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string> }[];
    }
  >;
}

/** From `packages/backend/src/db/__tests__`, the repo root is five levels up. */
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-aws.yml');
const QUALITY_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'quality.yml');

const workflowSource = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = Bun.YAML.parse(workflowSource) as WorkflowFile;
const quality = Bun.YAML.parse(fs.readFileSync(QUALITY_PATH, 'utf8')) as WorkflowFile;

const selectorSteps = workflow.jobs.deploy.steps.filter((step) =>
  step.name?.startsWith('Select migrations ('),
);

const selectorFor = (prefix: string): { if?: string; run?: string } => {
  const step = selectorSteps.find((candidate) => candidate.name?.startsWith(prefix));
  expect(step, `no selector step named ${prefix}`).toBeDefined();
  return step ?? {};
};

describe('the deploy workflow and the migrator agree', () => {
  it('offers the cutover override, defaulted to the phased pair', () => {
    const input = workflow.on.workflow_dispatch?.inputs?.migration_phase;
    expect(input, 'the migration_phase dispatch input is gone').toBeDefined();
    expect(input?.default).toBe('pre-post');
    expect(input?.options).toEqual(['pre-post', 'all']);
  });

  it('passes only phase values the migrator accepts', () => {
    // Vacuity floor on both sides: an empty MIGRATION_RUNS would make the
    // membership check unfalsifiable, and a regex that matched nothing would
    // make it vacuous. The workflow spells `--phase=` four times — three
    // migration runs plus the CI migrate step.
    // Widened to `string[]` on purpose: the whole point is to compare values the
    // migrator has NOT been told about, which a `MigrationRun[]` cannot express.
    const accepted: readonly string[] = MIGRATION_RUNS;
    expect(accepted.length).toBeGreaterThan(0);
    const phases = [...workflowSource.matchAll(/--phase=([a-z-]+)/g)].map((match) => match[1]);
    expect(phases.length).toBeGreaterThanOrEqual(4);
    for (const phase of phases) {
      expect(accepted).toContain(phase);
    }
  });

  it('runs the built migrator by the path the runtime image actually contains', () => {
    // `dist/src/db/migrate.js` under `node`: the runtime stage of the Dockerfile
    // is node:22-alpine and never copies bun in, and tsconfig's `rootDir: "./"`
    // preserves `src/` inside `dist/`. And `--target-database=`, which the
    // migrator refuses to run without — a migration aimed at the wrong database
    // reports success over an untouched one rather than failing.
    for (const selector of selectorSteps) {
      expect(selector.run).toContain('"node","packages/backend/dist/src/db/migrate.js"');
      expect(selector.run).toContain('--target-database=syra"');
    }
  });

  it('runs the cutover and the phased pair as MUTUALLY EXCLUSIVE paths', () => {
    expect(selectorSteps).toHaveLength(2);
    expect(selectorFor('Select migrations (cutover').if).toBe(
      "github.event.inputs.migration_phase == 'all'",
    );
    expect(selectorFor('Select migrations (default').if).toBe(
      "github.event.inputs.migration_phase != 'all'",
    );
  });

  it('applies the whole journal on the cutover, and no post task after it', () => {
    // The empty POST value is what tells deploy-ecs-image.sh to skip that task.
    // A `post` run after `all` could only find nothing pending — a way for a
    // green cutover to end on a red step.
    const cutover = selectorFor('Select migrations (cutover').run ?? '';
    expect(cutover).toContain('"--phase=all"');
    expect(cutover).not.toContain('"--phase=post"');
    expect(cutover).toMatch(/^\s*echo 'POST_DEPLOY_TASK_COMMAND_JSON='$/m);

    const phased = selectorFor('Select migrations (default').run ?? '';
    expect(phased).toContain('"--phase=pre"');
    expect(phased).toContain('"--phase=post"');
    expect(phased).not.toContain('"--phase=all"');
  });

  it('sets the one-shot commands ONLY from the selectors, never on the deploy step', () => {
    // A value hardcoded on the deploy step's `env:` is immune to every `if:` in
    // this file, so it would ride along with the cutover regardless.
    const deployStep = workflow.jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Register immutable task definition'),
    );
    expect(deployStep, 'the deploy step is gone').toBeDefined();
    for (const variable of ['PRE_DEPLOY_TASK_COMMAND_JSON', 'POST_DEPLOY_TASK_COMMAND_JSON']) {
      // Once per selector, written to $GITHUB_ENV — and nowhere else.
      const assignments = [...workflowSource.matchAll(new RegExp(`^\\s*echo '${variable}=`, 'gm'))];
      expect(assignments).toHaveLength(2);
      // The YAML-key spelling (`NAME: value`) is the one that binds an env var
      // to a step unconditionally; the selectors use the shell spelling instead.
      expect(workflowSource).not.toMatch(new RegExp(`^\\s*${variable}:`, 'm'));
    }
  });
});

describe('the deploy workflow can actually run its own gate', () => {
  it('gives the Postgres-backed suite the same database quality.yml gives it', () => {
    // 92 backend test files reach `src/test/postgres.ts`, whose `beforeAll`
    // throws without this. Compared against quality.yml rather than restated:
    // two hand-maintained copies of a service definition drift, and the drift
    // shows up as a suite that passes in one workflow and fails in the other.
    expect(workflow.jobs.test.services?.postgres).toEqual(quality.jobs.quality.services?.postgres);
    expect(workflow.jobs.test.env?.TEST_DATABASE_URL).toBe(
      quality.jobs.quality.env?.TEST_DATABASE_URL,
    );
    expect(workflow.jobs.test.env?.TEST_DATABASE_URL).toContain('postgres://');
  });

  it('migrates that database BEFORE running the suite against it', () => {
    // `src/test/postgres.ts` opens the schema, it does not create it.
    const steps = workflow.jobs.test.steps;
    const migrateAt = steps.findIndex((step) => step.run?.includes('db:migrate'));
    const suiteAt = steps.findIndex((step) => step.run?.includes('cd packages/backend && bun run test'));
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(suiteAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeLessThan(suiteAt);
  });

  it('runs the suite on the same architecture quality.yml runs it on', () => {
    // The two jobs are compared field-by-field above, which is only worth
    // anything if they run the same way. This is NOT a claim that the ARM label
    // is broken — it is not; see the note on `deploy`'s `runs-on`.
    expect(workflow.jobs.test['runs-on']).toBe(quality.jobs.quality['runs-on']);
  });

  it('builds the arm64 image on an arm64 host, without an emulator', () => {
    // Emulated arm64 is much slower, and the outage that motivated moving this
    // job to x86 + QEMU had a different cause (a workflow-approval block, which
    // no runner label affects). If a future change genuinely needs emulation it
    // has to remove this assertion deliberately rather than drift into it.
    expect(workflow.jobs.deploy['runs-on']).toContain('arm');
    const qemu = workflow.jobs.deploy.steps.find((step) =>
      step.uses?.startsWith('docker/setup-qemu-action@'),
    );
    expect(qemu, 'a native arm64 host does not need the QEMU emulator').toBeUndefined();
  });
});
