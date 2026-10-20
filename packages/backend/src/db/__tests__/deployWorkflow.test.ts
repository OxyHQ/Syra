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
import { MIGRATION_RUNS } from '@oxy.so/db/migrate';

/** Only the shape these assertions read — not a schema for GitHub Actions. */
interface WorkflowFile {
  name?: string;
  on: {
    workflow_dispatch?: {
      inputs?: Record<string, { default?: string; options?: string[] }>;
    };
    workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] };
  };
  jobs: Record<
    string,
    {
      'runs-on': string;
      if?: string;
      needs?: string | string[];
      concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
      env?: Record<string, string>;
      services?: Record<string, unknown>;
      steps: {
        name?: string;
        id?: string;
        if?: string;
        run?: string;
        uses?: string;
        with?: Record<string, string>;
        env?: Record<string, string>;
      }[];
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
    // make it vacuous. The workflow spells `--phase=` at least three times —
    // the three migration runs (all, pre, post). The CI migrate step that used
    // to be a fourth now lives only in quality.yml, which is checked below.
    // Widened to `string[]` on purpose: the whole point is to compare values the
    // migrator has NOT been told about, which a `MigrationRun[]` cannot express.
    const accepted: readonly string[] = MIGRATION_RUNS;
    expect(accepted.length).toBeGreaterThan(0);
    const phases = [...workflowSource.matchAll(/--phase=([a-z-]+)/g)].map((match) => match[1]);
    expect(phases.length).toBeGreaterThanOrEqual(3);
    for (const phase of phases) {
      expect(accepted).toContain(phase);
    }
  });

  it('runs the built migrator by the path the runtime image actually contains', () => {
    // `dist/src/db/migrate.js` under `bun`: the runner stage of the Dockerfile is
    // oven/bun:1.4.3-alpine and has no Node in it, and tsconfig's `rootDir: "./"`
    // preserves `src/` inside `dist/`. And `--target-database=`, which the
    // migrator refuses to run without — a migration aimed at the wrong database
    // reports success over an untouched one rather than failing.
    for (const selector of selectorSteps) {
      expect(selector.run).toContain('"bun","packages/backend/dist/src/db/migrate.js"');
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

/**
 * The deploy releases only what Quality passed, and no longer re-tests.
 *
 * Until 2026-10 this workflow ran on `push` with a `test` job of its own (the
 * Postgres-backed suite, migrated first, compared field-by-field with
 * quality.yml's). That job repeated Quality's work on the same push; now the
 * deploy runs on `workflow_run` of Quality, so the gate IS Quality, for the
 * exact commit released. What these assertions hold is that the chain cannot
 * quietly come apart: a renamed workflow, a dropped guard, or a deploy that
 * builds a different commit than the one Quality tested would each release
 * untested code with every check green.
 */
describe('the deploy workflow releases only what Quality passed', () => {
  it('runs after the Quality workflow, on main', () => {
    // `workflows:` matches by NAME; a rename of quality.yml would leave this
    // trigger listening for a workflow that never runs again — no deploys, and
    // no error anywhere.
    expect(quality.name).toBe('Quality');
    expect(workflow.on.workflow_run?.workflows).toEqual([quality.name ?? '']);
    expect(workflow.on.workflow_run?.types).toEqual(['completed']);
    expect(workflow.on.workflow_run?.branches).toEqual(['main']);
    expect(Object.keys(workflow.on)).not.toContain('push');
  });

  it('admits only a successful push run on main of this repository', () => {
    // `completed` fires for failures and cancellations too, and for runs from
    // forks' branches named main; every guard is load-bearing.
    const guard = (workflow.jobs.scope?.if ?? '').replace(/\s+/g, ' ');
    for (const condition of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
      "github.event.workflow_run.head_branch == 'main'",
    ]) {
      expect(guard).toContain(condition);
    }
    expect(workflow.jobs.deploy.needs).toBe('scope');
    expect(workflow.jobs.deploy.if).toContain("needs.scope.outputs.backend == 'true'");
    expect(workflow.jobs.deploy.if).toContain("github.ref == 'refs/heads/main'");
  });

  it('builds and tags the commit Quality tested, not main as it is now', () => {
    // On `workflow_run`, `github.sha` is main's head when the event was
    // created, which may be a newer commit nothing tested yet.
    expect(workflowSource).toMatch(
      /^\s*RELEASE_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \|\| github\.sha \}\}$/m,
    );
    const checkout = workflow.jobs.deploy.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout?.with?.ref).toBe('${{ env.RELEASE_SHA }}');
    const build = workflow.jobs.deploy.steps.find((step) => step.id === 'build');
    expect(build?.env?.COMMIT_TAG).toBe('${{ env.RELEASE_SHA }}');
    expect(build?.run).not.toContain('GITHUB_SHA');
  });

  it('serializes rollouts on the deploy job and never cancels one', () => {
    const lane = workflow.jobs.deploy.concurrency;
    expect(lane?.group).toBe('deploy-syra-backend');
    expect(lane?.['cancel-in-progress']).toBe(false);
  });

  it('leaves Quality migrating its database BEFORE the backend suite runs', () => {
    // The check the deleted `test` job held for itself. `src/test/postgres.ts`
    // opens the schema, it does not create it.
    const steps = quality.jobs.quality.steps;
    const migrateAt = steps.findIndex((step) => step.run?.includes('db:migrate'));
    const suiteAt = steps.findIndex((step) =>
      step.run?.includes('bun run --filter @syra/backend test'),
    );
    expect(migrateAt).toBeGreaterThanOrEqual(0);
    expect(suiteAt).toBeGreaterThanOrEqual(0);
    expect(migrateAt).toBeLessThan(suiteAt);
    expect(quality.jobs.quality.env?.TEST_DATABASE_URL).toContain('postgres://');
  });

  it('keeps the i18n key check the deleted `test` job was the only one to run on main', () => {
    const steps = quality.jobs.quality.steps;
    expect(steps.some((step) => step.run?.includes('bun run check-i18n'))).toBe(true);
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

/**
 * Runtime secrets live in SSM Parameter Store, and no workflow writes one.
 *
 * Until 2026-10-10 a step here copied an allowlist of GitHub repo secrets into
 * SSM on every deploy, which made GitHub the source of truth for production
 * credentials: whoever could edit a repo secret could change what production
 * ran with, and every value lived in two systems. SSM (`/oxy/syra/*`,
 * SecureString) is now the only source; a value is set or rotated with
 * `aws ssm put-parameter --overwrite` by its owner (oxy-infra runbook 46),
 * never by a workflow.
 *
 * Every workflow is read, not only the deploy: the property is "GitHub holds no
 * app runtime secret", and a second workflow reading one would break it as
 * surely as this one. Each half can regress alone, so both are asserted — a step
 * that writes SSM again, and a workflow that reads a secret outside the CI-only
 * allowlist. `toJSON(secrets)` stays prohibited by name: besides reading every
 * secret, it is the shape GitHub's malicious-workflow detection matches, which
 * held every run at `action_required` with ZERO jobs (measured across the org
 * on 2026-08-08; see the note on `deploy`'s `runs-on`).
 */
describe('runtime secrets come from SSM, and no workflow writes one', () => {
  /** What CI itself spends. Nothing here is read by the running service. */
  const CI_ONLY_SECRETS = [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
  ];

  const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
  const workflowFiles = fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map((file) => ({ file, source: fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8') }));

  it('reads every workflow, including the deploy', () => {
    // Vacuity floor: an empty or misdirected directory read would make every
    // assertion below pass against nothing.
    expect(workflowFiles.map(({ file }) => file)).toContain('deploy-aws.yml');
    expect(workflowFiles.length).toBeGreaterThan(1);
  });

  it('never writes an SSM parameter', () => {
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    expect(steps.length).toBeGreaterThan(5);
    for (const step of steps) {
      expect(step.run ?? '', `step "${step.name ?? '?'}" writes SSM`).not.toMatch(
        /ssm\s+put-parameter/,
      );
    }
    for (const { file, source } of workflowFiles) {
      const executable = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
      expect(executable, `${file} writes SSM`).not.toMatch(/ssm\s+put-parameter/);
    }
  });

  it('never enumerates the whole secrets context', () => {
    // Matched as an EXPRESSION, not as text, so a comment explaining the block
    // by name does not trip it.
    for (const { file, source } of workflowFiles) {
      expect(source, file).not.toMatch(/\$\{\{[^}]*toJSON\s*\(\s*secrets\s*\)/);
    }
  });

  it('reads no repo secret outside the CI-only allowlist', () => {
    const named = workflowFiles.flatMap(({ source }) =>
      [...source.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]),
    );
    expect(
      named.length,
      'no secret is read anywhere, so the matcher measures nothing',
    ).toBeGreaterThan(0);
    for (const name of new Set(named)) {
      expect(CI_ONLY_SECRETS, `a workflow reads app secret ${name} from GitHub`).toContain(name);
    }
  });

  it('reads no GitHub secret at all in the deploy', () => {
    expect([...workflowSource.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)]).toEqual([]);
  });

  it('injects only /oxy/syra/ parameters into the revisions it registers', () => {
    // TASK_SECRET_OVERRIDES_JSON names parameters every registered revision
    // reads. A revision naming a parameter that does not exist does not fail the
    // deploy — it fails at TASK LAUNCH with `ResourceInitializationError`. No
    // step creates them any more, so a new entry is preceded by its owner
    // writing the parameter; this pins that each one is an app parameter and not
    // a shared one, which oxy-infra owns.
    const deployStep = workflow.jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Register immutable task definition'),
    );
    expect(deployStep, 'the deploy step is gone').toBeDefined();
    const overrides = JSON.parse(deployStep?.env?.TASK_SECRET_OVERRIDES_JSON ?? '{}') as Record<
      string,
      string
    >;
    const injected = Object.keys(overrides);
    expect(injected.length, 'no overrides parsed — the assertion would be vacuous').toBeGreaterThan(
      0,
    );
    for (const name of injected) {
      expect(overrides[name]).toBe(`arn:aws:ssm:us-west-2:237343248947:parameter/oxy/syra/${name}`);
    }
  });

  /**
   * The Oxy service credential has to LEAVE the task definition, and only a
   * removal list can take it out.
   *
   * Every release renders from the definition the service is RUNNING, so a
   * secret that reached a revision by hand or by Terraform survives every future
   * deploy. Not naming it here is not removal — it is the status quo — which is
   * why this asserts the presence of the instruction rather than the absence of
   * a line. Syra attests its ECS task role for a service token now (oxy ADR
   * 0026, `src/oxyClient.ts`). A name in BOTH lists is refused by
   * `deploy-ecs-image.sh`.
   */
  it('removes the retired secrets from every revision it registers', () => {
    const deployStep = workflow.jobs.deploy.steps.find((step) =>
      step.name?.startsWith('Register immutable task definition'),
    );
    expect(deployStep, 'the deploy step is gone').toBeDefined();
    const removals = (deployStep?.env?.TASK_SECRET_REMOVALS ?? '').split(/\s+/).filter(Boolean);
    // The Oxy service credential, and OXY_FILES_RECONCILE — the nightly
    // reference reconciliation always applies, with no mode to set.
    expect(removals).toEqual([
      'OXY_SERVICE_API_KEY',
      'OXY_SERVICE_API_SECRET',
      'OXY_FILES_RECONCILE',
    ]);

    const overrides = JSON.parse(deployStep?.env?.TASK_SECRET_OVERRIDES_JSON ?? '{}') as Record<
      string,
      string
    >;
    for (const name of removals) {
      expect(Object.keys(overrides), `${name} is both injected and removed`).not.toContain(name);
    }
  });
});

/**
 * Every command that runs inside the backend image names the runtime the image
 * ships.
 *
 * The one-shots (the migrator this workflow brackets a rollout with, and
 * run-backend-script.yml's backfills) override the image's CMD with an argv of
 * their own, so nothing ties their first word to the Dockerfile. The failure is
 * asymmetric, which is why a test rather than care: oven/bun images put a
 * `node` symlink to bun on PATH, so a stale `node` against the Bun image still
 * runs (on Bun, while claiming Node), but a `bun` against a Node image dies at
 * task start, in the middle of a deploy. The runtime is read from the runner
 * stage's CMD, so switching the image back to Node fails here until every
 * command follows.
 */
describe('the image and the commands run in it agree on the runtime', () => {
  const dockerfile = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'backend', 'Dockerfile'),
    'utf8',
  );
  const instructions = dockerfile.split('\n').filter((line) => /^[A-Z]+\s/.test(line));
  const runnerFrom = instructions.filter((line) => line.startsWith('FROM ')).at(-1) ?? '';
  const cmdLine = instructions.filter((line) => line.startsWith('CMD ')).at(-1) ?? '';
  const cmd = JSON.parse(cmdLine.slice('CMD '.length)) as string[];
  const runtime = cmd[0];

  it('runs the server on Bun, from the oven/bun runner stage', () => {
    expect(runnerFrom).toMatch(/^FROM oven\/bun:\S+ AS runner$/);
    expect(cmd).toEqual(['bun', 'packages/backend/dist/server.js']);
  });

  it('runs both the cutover and the phased migrator on that runtime', () => {
    const commands = selectorSteps
      .flatMap((step) => [...(step.run ?? '').matchAll(/_COMMAND_JSON=(\[.*\])'$/gm)])
      .map((match) => JSON.parse(match[1]) as string[]);
    // all, pre and post: an empty list would pass any runtime.
    expect(commands).toHaveLength(3);
    for (const command of commands) {
      expect(command[0]).toBe(runtime);
    }
  });

  it('runs the one-off backend scripts on that runtime', () => {
    const scripts = Bun.YAML.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, '.github', 'workflows', 'run-backend-script.yml'),
        'utf8',
      ),
    ) as WorkflowFile;
    const step = scripts.jobs['run-script'].steps.find(
      (candidate) => candidate.name === 'Run as a one-off ECS task',
    );
    const template = /format\('(\[.*\])'/.exec(step?.env?.COMMAND_JSON ?? '')?.[1];
    expect(template, 'the one-off command template moved').toBeDefined();
    expect((JSON.parse(template?.replace('{0}', 'x') ?? '[]') as string[])[0]).toBe(runtime);
  });

  it('health-checks the container with that runtime', () => {
    expect(dockerfile).toMatch(new RegExp(`^\\s+CMD ${runtime} -e `, 'm'));
  });
});
