#!/usr/bin/env node
/**
 * Qualification run script (BACKLOG ALD-072).
 *
 * Runs a non-confirmatory software-qualification pass of the Nursery
 * Controller runtime — EXPERIMENT-NOTEBOOK.md's E03 controls-and-oracle
 * and/or E11 from-scratch RL naming game — against the real evidence store,
 * the real checkpoint service, and the real independent verifier
 * (`packages/orchestrator/src/production.ts`'s `createProductionRuntime`),
 * in Prototype Mode with no Base anchor. It then writes the qualification
 * report (`writeQualificationReport`).
 *
 * This is plumbing, not research: every run this script produces has an
 * `invalid` Experiment Record disposition by construction
 * (SPECIFICATION.md §7.2 — no anchor was submitted), is not pre-registered,
 * and is not a qualification in EXPERIMENT-NOTEBOOK.md's sense. See
 * `QUALIFICATION_LABEL` in the generated report.
 *
 * REQUIRES `pnpm run build` FIRST: this script imports `@ald/orchestrator`
 * (and its dependencies) from their built `dist/` output — it is a plain
 * Node ESM script, not run through `tsx`/`ts-node`.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `
Usage: node scripts/run-qualification.mjs [options]

Runs a non-confirmatory software-qualification pass of the Nursery Controller
runtime (BACKLOG ALD-072): E03 controls-and-oracle and/or the E11 from-scratch
RL naming game, against the real evidence store, checkpoint service, and
independent verifier (Prototype Mode, no Base anchor submitted).

REQUIRES \`pnpm run build\` FIRST — this script imports @ald/orchestrator and
its dependencies from their built dist/ output, not from TypeScript source.

Options:
  --e03-seeds <n>     Seeds per E03 condition (default 5)
  --e03-episodes <n>  Evaluation episodes per E03 run (default 200)
  --e11-seeds <n>     Seeds for the E11 naming game (default 3)
  --e11-train <n>     Training turns per E11 run (default 3000)
  --e11-eval <n>      Evaluation turns per E11 run (default 200)
  --skip-e03          Skip the E03 controls
  --skip-e11          Skip the E11 naming game
  --out <dir>         Report output directory
                        (default reports/qualification/<runSetId>)
  --db <path>         SQLite evidence store path
                        (default evidence/qualification/<runSetId>.sqlite)
  --bundles <dir>     Bundle export root
                        (default evidence/qualification/<runSetId>/bundles)
  -h, --help          Show this help and exit

runSetId defaults to <YYYYMMDD-HHmm>-<short git sha>.

Example — the standard 5-seed E03 + 3-seed E11 qualification run:

  pnpm run build
  node scripts/run-qualification.mjs

The report lands in reports/qualification/<runSetId>/ (REPORT.md,
e03-summary.json, e11-summary.json); the evidence database and exported
bundles land in evidence/qualification/<runSetId>*, which .gitignore already
excludes (see reports/README.md).

Exits 1 if any produced evidence bundle fails independent verification
(exit code != 0), printing which run(s) failed; exits 0 otherwise.
`;

function shortSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'nogit';
  }
}

function fullSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function timestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

const { values } = parseArgs({
  options: {
    'e03-seeds': { type: 'string', default: '5' },
    'e03-episodes': { type: 'string', default: '200' },
    'e11-seeds': { type: 'string', default: '3' },
    'e11-train': { type: 'string', default: '3000' },
    'e11-eval': { type: 'string', default: '200' },
    'skip-e03': { type: 'boolean', default: false },
    'skip-e11': { type: 'boolean', default: false },
    out: { type: 'string' },
    db: { type: 'string' },
    bundles: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runSetId = `${timestamp()}-${shortSha()}`;
const outDir = values.out
  ? resolve(values.out)
  : join(repoRoot, 'reports', 'qualification', runSetId);
const databasePath = values.db
  ? resolve(values.db)
  : join(repoRoot, 'evidence', 'qualification', `${runSetId}.sqlite`);
const bundleRoot = values.bundles
  ? resolve(values.bundles)
  : join(repoRoot, 'evidence', 'qualification', runSetId, 'bundles');
const softwareCommit = fullSha();

const e03Seeds = parsePositiveInt(values['e03-seeds'], '--e03-seeds');
const e03Episodes = parsePositiveInt(values['e03-episodes'], '--e03-episodes');
const e11Seeds = parsePositiveInt(values['e11-seeds'], '--e11-seeds');
const e11Train = parsePositiveInt(values['e11-train'], '--e11-train');
const e11Eval = parsePositiveInt(values['e11-eval'], '--e11-eval');

if (values['skip-e03'] && values['skip-e11']) {
  console.error('Both --skip-e03 and --skip-e11 given; nothing to run.');
  process.exit(1);
}

let orchestrator;
try {
  orchestrator = await import('@ald/orchestrator');
} catch (error) {
  console.error(
    'Failed to load @ald/orchestrator — run `pnpm run build` first ' +
      '(this script requires the built dist/ output, not TypeScript source).',
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
const {
  createProductionRuntime,
  runE03Controls,
  runE11NamingGame,
  writeQualificationReport,
} = orchestrator;

// Shared across both experiments so a single `scratch-rl` config applies to
// every E11 run; E03's no-learning Babies ignore it (BACKLOG ALD-072).
const learnerOptions = { learningRate: 1, temperature: 0.5, messageLength: 1 };

console.log(`Qualification run ${runSetId}`);
console.log(`  software commit: ${softwareCommit}`);
console.log(`  evidence database: ${databasePath}`);
console.log(`  bundle root: ${bundleRoot}`);
console.log(`  report output: ${outDir}`);

const production = createProductionRuntime({
  databasePath,
  bundleRoot,
  softwareCommit,
  learnerOptions: { shared: learnerOptions },
});

let e03Result;
let e11Result;
try {
  if (!values['skip-e03']) {
    console.log(
      `\n== E03 controls: ${String(e03Seeds)} seed(s) x 6 conditions, ` +
        `${String(e03Episodes)} evaluation episodes each ==`,
    );
    e03Result = await runE03Controls(production.runtime, {
      seeds: e03Seeds,
      episodes: e03Episodes,
      softwareCommit,
      onProgress: (event) => {
        console.log(
          `  [E03] ${event.condition} seed ${String(event.slot)}: ` +
            `${event.runId} -> ${event.state} ` +
            `(success rate ${(event.successRate * 100).toFixed(1)}%)`,
        );
      },
    });
  }

  if (!values['skip-e11']) {
    console.log(
      `\n== E11 naming game: ${String(e11Seeds)} seed(s), ` +
        `${String(e11Train)} training turns, ${String(e11Eval)} evaluation turns ==`,
    );
    e11Result = await runE11NamingGame(production.runtime, {
      seeds: e11Seeds,
      trainingTurns: e11Train,
      evaluationTurns: e11Eval,
      learnerOptions,
      softwareCommit,
      onProgress: (event) => {
        console.log(
          `  [E11] seed ${String(event.slot)}: ${event.runId} -> ${event.state} ` +
            `(evaluation success ${(event.evaluationSuccess * 100).toFixed(1)}%)`,
        );
      },
    });
  }
} finally {
  production.close();
}

console.log(`\nWriting qualification report to ${outDir}`);
const { files } = await writeQualificationReport(outDir, {
  ...(e03Result ? { e03: e03Result } : {}),
  ...(e11Result ? { e11: e11Result } : {}),
  runSetId,
  nodeVersion: process.version,
});
for (const file of files) {
  console.log(`  wrote ${file}`);
}

const failing = [];
for (const [runId, exitCode] of Object.entries(
  e03Result?.verifierExitCodes ?? {},
)) {
  if (exitCode !== 0) {
    failing.push(runId);
  }
}
for (const run of e11Result?.runs ?? []) {
  if (run.verifierExitCode !== 0) {
    failing.push(run.runId);
  }
}

if (failing.length > 0) {
  console.error(
    `\n${String(failing.length)} run(s) failed independent verification:`,
  );
  for (const runId of failing) {
    console.error(`  - ${runId}`);
  }
  process.exit(1);
}

console.log('\nAll evidence bundles verified.');
process.exit(0);
