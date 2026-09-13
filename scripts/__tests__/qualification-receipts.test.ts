/* eslint-disable @typescript-eslint/no-explicit-any -- deliberately malformed JSON fixtures exercise CLI validation */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim();
const temporaryDirectories: string[] = [];
const paths = {
  e00: ['reports/research/e00-integrity-qualification-receipt.json', 'protocols/e00-registration.v5.json', 'protocols/e00-registration-binding.v4.json'],
  e01: ['reports/research/e01-isolation-qualification-receipt.json', 'protocols/e01-registration.v1.json', 'protocols/e01-registration-binding.v1.json'],
};
type Experiment = keyof typeof paths;
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));

function fixture(experiment: Experiment, mutate = (_receipt: ReturnType<typeof read>) => {}, raw = true) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-receipt-test-'));
  temporaryDirectories.push(directory);
  const write = (path: string, value: unknown) => {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  const [receiptPath, ...protocolPaths] = paths[experiment];
  protocolPaths.forEach((path) => write(path, read(path)));
  const receipt = read(receiptPath);
  mutate(receipt);
  write(receiptPath, receipt);
  if (raw) {
    for (const slot of receipt.slots) {
      if (experiment === 'e00') write(`${slot.retainedBundle}/run-manifest.json`, { runId: slot.runId });
      else write(`${receipt.retainedEvidenceRoot}/slot-${String(slot.slot).padStart(2, '0')}.json`, slot);
    }
  }
  return { directory, write, receipt };
}

function run(experiment: Experiment, directory: string, live = false) {
  return spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    join(root, `scripts/check-${experiment}-qualification.ts`),
    ...(live ? ['--live-evidence'] : []),
  ], { cwd: directory, env: { ...process.env, GIT_DIR: gitDir }, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each(['e00', 'e01'] as const)('%s receipt audit', (experiment) => {
  it('checks a tracked receipt without depending on ignored local evidence', () => {
    const { directory } = fixture(experiment, undefined, false);
    const result = run(experiment, directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('raw evidence not checked');
  });

  it('fails an explicit live audit if raw evidence is absent', () => {
    const { directory } = fixture(experiment, undefined, false);
    const result = run(experiment, directory, true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOENT');
  });

  it('compares retained records when live evidence is requested', () => {
    const { directory, write, receipt } = fixture(experiment);
    expect(run(experiment, directory, true).status).toBe(0);
    const slot = receipt.slots[0];
    const path = experiment === 'e00'
      ? `${slot.retainedBundle}/run-manifest.json`
      : `${receipt.retainedEvidenceRoot}/slot-01.json`;
    write(path, { ...slot, runId: 'foreign-run' });
    expect(run(experiment, directory, true).status).not.toBe(0);
  });
});

describe('E01 incomplete and contradictory evidence', () => {
  const mutations = [
    ['duplicate Gateway attack', (slot: any) => { slot.gateway.attempts[1] = slot.gateway.attempts[0]; }],
    ['missing Gateway evidence references', (slot: any) => { slot.gateway.attempts[0].evidenceRefs = []; }],
    ['duplicate host attack', (slot: any) => { slot.host.attempts[1] = slot.host.attempts[0]; }],
    ['missing peer routes', (slot: any) => { slot.topology.directPeerRoutes = []; }],
    ['empty container identity', (slot: any) => { slot.topology.containerIds[0] = ''; }],
    ['missing timing pair', (slot: any) => { slot.transport.timing.pairs = []; }],
    ['missing size pair', (slot: any) => { slot.transport.size.pairs = []; }],
    ['nonnumeric timing', (slot: any) => { slot.transport.timing.pairs[0].absoluteMeanDifference = 'invalid'; }],
    ['negative timing', (slot: any) => { slot.transport.timing.pairs[0].absoluteMeanDifference = -1; }],
    ['wrong sample allocation', (slot: any) => { slot.transport.timing.labels[0].count = 1; }],
    ['timing violation hidden by stale pair summary', (slot: any) => { slot.transport.timing.labels[0].mean += 1000; }],
    ['missing measured timing mean', (slot: any) => { delete slot.transport.timing.labels[0].mean; }],
    ['equal but wrong frame sizes', (slot: any) => { slot.transport.size.labels.forEach((label: any) => { label.mean = 4096; }); }],
    ['renamed category', (slot: any) => { delete slot.categoryDecisions.timing; slot.categoryDecisions.unmeasured = true; }],
    ['renamed detector control', (slot: any) => { delete slot.positiveControls.hostExposureDetected; slot.positiveControls.unmeasured = true; }],
    ['missing extraction disposition', (slot: any) => { delete slot.gateway.attempts[0].extractedByRecipient; }],
    ['string pass flag', (slot: any) => { slot.passed = 'true'; }],
    ['missing detector bound', (slot: any) => { delete slot.correlationDetector.boundBits; }],
  ] as const;
  it.each(mutations)('rejects %s even when retained JSON agrees', (_label, mutate) => {
    const { directory } = fixture('e01', (receipt) => mutate(receipt.slots[0]));
    expect(run('e01', directory, true).status).not.toBe(0);
  });
});

describe('current project status', () => {
  function statusFixture() {
    const directory = mkdtempSync(join(tmpdir(), 'ald-status-test-'));
    temporaryDirectories.push(directory);
    for (const path of [
      'package.json', 'pnpm-lock.yaml', 'BACKLOG.md', 'README.md', 'RESEARCH.md',
      'EXPERIMENT-NOTEBOOK.md', 'protocols/campaign-readiness-review.v1.json',
      'reports/research/e02-qualification-receipt.json',
      'reports/phase-one-research-update.md',
      'reports/research/research-validation-report.md',
      'reports/research/research-critical-review.md',
      'reports/research/methods-readiness-review.md',
    ]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), readFileSync(join(root, path)));
    }
    return directory;
  }
  const check = (directory: string) => spawnSync(process.execPath,
    [join(root, 'scripts/check-project-status.mjs')], { cwd: directory, encoding: 'utf8' });

  it('works without any local plans', () => {
    const result = check(statusFixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['README.md', 'reports/research/methods-readiness-review.md'])('rejects stale counts in %s', (path) => {
    const directory = statusFixture();
    const target = join(directory, path);
    const original = readFileSync(target, 'utf8');
    const changed = original.replace(/\d+ not started;/u, '99 not started;');
    expect(changed).not.toBe(original);
    writeFileSync(target, changed);
    const result = check(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(path);
  });

  it('rejects an E02 notebook attempt that contradicts campaign progress', () => {
    const directory = statusFixture();
    const target = join(directory, 'EXPERIMENT-NOTEBOOK.md');
    const original = readFileSync(target, 'utf8');
    writeFileSync(target, original.replace('| E02 | Observation and metadata leakage audit | E00 | Not started |',
      '| E02 | Observation and metadata leakage audit | E00 | Running |'));
    const result = check(directory);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('E02 notebook attempt/disposition contradicts the campaign progress record');
  });
});

describe('historical workflow observation', () => {
  function observationFixture(mutate = (_observation: any) => {}) {
    const directory = mkdtempSync(join(tmpdir(), 'ald-history-test-'));
    temporaryDirectories.push(directory);
    for (const path of [
      'reports/research/external-prerequisite-readiness.json',
      'protocols/campaign-readiness-review.v1.json',
      'protocols/research-governance-and-funding.v1.json',
      'reports/research/upstream-enforcement-observation.json',
    ]) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      if (path.endsWith('upstream-enforcement-observation.json')) {
        const observation = read(path);
        mutate(observation);
        writeFileSync(join(directory, path), JSON.stringify(observation));
      } else writeFileSync(join(directory, path), readFileSync(join(root, path)));
    }
    return directory;
  }
  const check = (directory: string) => spawnSync(process.execPath, [
    '--import', resolve(root, 'node_modules/tsx/dist/loader.mjs'),
    join(root, 'scripts/check-external-prerequisite-readiness.ts'),
  ], { cwd: directory, env: { ...process.env, GIT_DIR: gitDir }, encoding: 'utf8' });

  it('verifies the recorded workflow from history without requiring a working copy', () => {
    const result = check(observationFixture());
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a mismatched historical workflow hash', () => {
    const result = check(observationFixture((observation) => {
      observation.localWorkflow.sha256 = '0'.repeat(64);
    }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('historical upstream observation');
  });
});

describe('E00 incomplete and contradictory evidence', () => {
  const mutations = [
    ['missing event count', (slot: any) => { delete slot.eventCount; }],
    ['nonnumeric checkpoint count', (slot: any) => { slot.checkpointCount = 'invalid'; }],
    ['fractional checkpoint count', (slot: any) => { slot.checkpointCount = 3.5; }],
    ['string anchor flag', (slot: any) => { slot.anchored = 'true'; }],
    ['missing mutation verdict', (slot: any) => { delete slot.cases[1].auditorPass; }],
    ['redirected retained bundle', (slot: any) => { slot.retainedBundle = 'evidence/other-run'; }],
  ] as const;
  it.each(mutations)('rejects %s', (_label, mutate) => {
    const { directory } = fixture('e00', (receipt) => mutate(receipt.slots[0]));
    expect(run('e00', directory, true).status).not.toBe(0);
  });
});
