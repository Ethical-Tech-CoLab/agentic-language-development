import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindLv01StagePacket, compileLv01StagePacket } from '@ald/orchestrator';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../lv01.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

const fixturePaths = (stage: string, version: string): string[] => [
  `protocols/lv01-${stage}-resource-allocation.v${version}.json`,
  `protocols/lv01-${stage}-registration.v${version}.json`,
  `protocols/lv01-${stage}-registration-binding.v${version}.json`,
  `reports/research/lv01-topology-qualification.v${version}.json`,
  `reports/research/lv01-${stage}-gate-receipt.v${version}.json`,
];
const cleanFixtures = (stage: string, version: string, keepAllocation = false): void => {
  for (const path of fixturePaths(stage, version)) {
    // v1 development uses the REAL tracked allocation: never delete it.
    if (keepAllocation && path.endsWith(`resource-allocation.v${version}.json`)) continue;
    rmSync(join(root, path), { force: true });
  }
  // Blocked-verdict sidecars never take the canonical path; remove them too.
  const dir = join(root, 'reports/research');
  const prefix = `lv01-${stage}-gate-receipt.v${version}.blocked.`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true });
  }
};
const writeTopologyStub = (version: string): void => {
  writeFileSync(
    join(root, `reports/research/lv01-topology-qualification.v${version}.json`),
    '{"schemaVersion": 1, "studyId": "LV01", "passed": true}\n',
  );
};
// NOTE: v1 development uses the REAL tracked allocation packet plus a bound
// topology stub. Never write allocation fixtures over tracked v1 files.
const writeGateStubs = (stage: string, version: string): void => {
  writeFileSync(
    join(root, `protocols/lv01-${stage}-resource-allocation.v${version}.json`),
    '{"schemaVersion": 1, "studyId": "LV01", "status": "design-locked-not-executed"}\n',
  );
  writeFileSync(
    join(root, `reports/research/lv01-topology-qualification.v${version}.json`),
    '{"schemaVersion": 1, "studyId": "LV01", "passed": true}\n',
  );
};
const writeBoundTopologyV1 = (): void => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(
    join(root, 'reports/research/lv01-topology-qualification.v1.json'),
    `${JSON.stringify({ schemaVersion: 1, studyId: 'LV01', passed: true, sourceCommit: head, designVersion: 1 })}\n`,
  );
};
const collectArgs = (stage: string, version: string): string[] => [
  'collect', '--stage', stage, '--version', version, '--run',
  '--parent-bundle', 'parent', '--evidence-dir', 'evidence', '--partition', 'dev',
  '--ordinary-id', 'uniform', '--store-root', 'store', '--database-path', 'db', '--owner', 'test',
];
const trackedTreeClean = (): boolean =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim() === '';

afterEach(() => {
  cleanFixtures('development', '1', true);
  cleanFixtures('development', '101');
  cleanFixtures('confirmatory', '102');
  cleanFixtures('development', '999');
});

describe('LV01 execution CLI', () => {
  it('reports the evidenced not-ready state without writing a receipt', () => {
    const result = run('status', '--live-evidence');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"executionReadiness": "blocked"');
    expect(result.stdout).toContain('"scientificDisposition": "not-tested"');
  });

  it('rejects a pilot collection that has no prospective packet', () => {
    const result = run(...collectArgs('pilot', '1'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing passed topology qualification');
  });

  it('rejects unknown options and immutable receipt rewrites', () => {
    expect(run('check-design', '--write').status).not.toBe(0);
    const result = run('qualify-numerics', '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('immutable');
    const allocation = run('allocate', '--stage', 'development', '--version', '1', '--write');
    expect(allocation.status).not.toBe(0);
    expect(allocation.stderr).toContain('immutable');
  });

  it('checks exact v1 and v2 design contracts and rejects other versions', () => {
    const v1 = run('check-design', '--version', '1');
    expect(v1.status).toBe(0);
    expect(v1.stdout).toContain('design v1 contracts valid');
    const v2 = run('check-design', '--version', '2');
    expect(v2.status).toBe(0);
    expect(v2.stdout).toContain('design v2 contracts valid');
    expect(v2.stdout).toContain('strict five-file');
    expect(run('check-design', '--version', '3').status).not.toBe(0);
    expect(run('check-design').status).not.toBe(0);
  });

  it('stops v2-design chains without a v2 numerical receipt', () => {
    writeGateStubs('confirmatory', '102');
    const result = run('compile', '--stage', 'confirmatory', '--version', '102', '--write');
    expect(result.status).not.toBe(0);
    // The power gate fires before the lock gate: no v1 receipt qualifies v2.
    expect(result.stderr).toContain('missing numerical qualification receipt');
  });

  it('refuses v2-design development without a v2 numerical receipt and writes nothing', () => {
    writeGateStubs('development', '101');
    const result = run('compile', '--stage', 'development', '--version', '101', '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing numerical qualification receipt');
    expect(existsSync(join(root, 'protocols/lv01-development-registration.v101.json'))).toBe(false);
  });

  it('rejects topology evidence with no bound source commit', () => {
    writeTopologyStub('1');
    if (!trackedTreeClean()) {
      const result = run('compile', '--stage', 'development', '--version', '1', '--write');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('clean tracked tree');
      return;
    }
    // Gate passes on passed:true; the script contract rejects the unbound stub.
    // (Uses the real tracked v1 allocation; the topology stub is cleaned after.)
    const result = run('compile', '--stage', 'development', '--version', '1', '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('carries no bound source commit');
  });

  it('compiles, binds, and fail-closed admits a stage with exact reasons', () => {
    writeBoundTopologyV1();
    if (!trackedTreeClean()) {
      const result = run('compile', '--stage', 'development', '--version', '1', '--write');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('clean tracked tree');
      return;
    }
    const compiled = run('compile', '--stage', 'development', '--version', '1', '--write');
    expect(compiled.status).toBe(0);
    expect(compiled.stdout).toContain('registered: sha256:');
    expect(run('compile', '--stage', 'development', '--version', '1', '--write').status).not.toBe(0);
    const bound = run('bind', '--stage', 'development', '--version', '1', '--write');
    expect(bound.status).toBe(0);
    expect(bound.stdout).toContain('bound: sha256:');
    const early = run(...collectArgs('development', '1'));
    expect(early.status).not.toBe(0);
    expect(early.stderr).toContain('missing admitted ready receipt');
    const admitted = run('admit', '--stage', 'development', '--version', '1', '--live-evidence');
    expect(admitted.status).not.toBe(0);
    expect(admitted.stdout).toContain('admission: blocked');
    // No R01-B clearance and no A0 lease exist: exactly these two reasons.
    // (Fails if an operator holds a live lease during the test run, which
    // would itself violate single-lease concurrency.)
    expect(admitted.stdout).toContain('blocked: resource-allocation-missing');
    expect(admitted.stdout).toContain('blocked: host-not-ready');
    // A blocked verdict never takes the canonical immutable path.
    expect(existsSync(join(root, 'reports/research/lv01-development-gate-receipt.v1.json'))).toBe(false);
    const sidecars = readdirSync(join(root, 'reports/research')).filter((name) =>
      name.startsWith('lv01-development-gate-receipt.v1.blocked.'),
    );
    expect(sidecars.length).toBe(1);
    expect(JSON.parse(readFileSync(join(root, 'reports/research', sidecars[0] as string), 'utf8'))).toMatchObject({
      status: 'blocked',
      reasons: ['resource-allocation-missing', 'host-not-ready'],
    });
  });

  it('collect rejects both parent-bundle and per-slot-parents', () => {
    const result = run(...collectArgs('development', '1'), '--per-slot-parents');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown or repeated option');
  });

  it('train-parents requires strict options and a bound packet', () => {
    const missing = run('train-parents', '--stage', 'development', '--version', '999');
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('missing required option');
    const unbound = run(
      'train-parents', '--stage', 'development', '--version', '999', '--run', '--slots', '1',
      '--parents-dir', 'parents', '--store-root', 'store', '--database-path', 'db',
      '--track', 'scratch-rl', '--model-ref', 'gru-actor-critic-v1', '--learning-signal', 'extrinsic-task',
      '--max-turns', '4', '--evaluation-turns', '1', '--ledger-value-plan', 'plan.json',
      '--deployment-mode', 'prototype', '--protocol-commit', 'git:test',
    );
    expect(unbound.status).not.toBe(0);
    expect(unbound.stderr).toContain('missing numerical qualification receipt');
  });

  it('trains per-slot parents then collects and audits through the stage scripts', () => {
    const version = '999';
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const hash = (char: string): string => `sha256:${char.repeat(64)}`;
    const allocation = {
      schemaVersion: 1,
      studyId: 'LV01',
      status: 'design-locked-not-executed',
      allocation: {
        smallFixture: { trainingCases: 4, validationFitCases: 2, validationSelectionCases: 2, withinSupportTestCases: 2 },
      },
    };
    const allocationPath = `protocols/lv01-development-resource-allocation.v${version}.json`;
    const allocationRaw = `${JSON.stringify(allocation)}\n`;
    writeFileSync(join(root, allocationPath), allocationRaw);
    const allocationSha = `sha256:${createHash('sha256').update(allocationRaw, 'utf8').digest('hex')}`;
    const compiled = compileLv01StagePacket({
      stage: 'development',
      version: 999,
      designVersion: 2,
      designCommitmentHash: hash('a'),
      analysisCommitmentHash: hash('b'),
      seedResourceCommitmentHash: hash('c'),
      sourceCommit: head,
      modelIdentity: {
        architecture: 'gru-actor-critic-v1',
        track: 'scratch-rl',
        parameterCountPerAgent: 4049,
        inputSize: 50,
        hiddenSize: 16,
      },
      allocation: { path: allocationPath, sha256: allocationSha },
      qualifications: {
        designCheck: 'passed',
        powerCheck: 'passed',
        topology: { path: `reports/research/lv01-topology-qualification.v${version}.json`, sha256: hash('f'), passed: true },
      },
      slotPlan: { primaries: 2, reserves: 1 },
    });
    writeFileSync(join(root, `protocols/lv01-development-registration.v${version}.json`), `${JSON.stringify(compiled)}\n`);
    writeFileSync(
      join(root, `protocols/lv01-development-registration-binding.v${version}.json`),
      `${JSON.stringify(bindLv01StagePacket(compiled, head, allocationSha))}\n`,
    );
    const work = mkdtempSync(join(tmpdir(), 'ald-lv01-g4b-'));
    try {
      const storeRoot = join(work, 'store');
      const evidenceDir = join(work, 'evidence');
      const parentsDir = join(evidenceDir, 'lv01', `development-v${version}`, 'parents');
      const planPath = join(work, 'ledger-value-plan.json');
      writeFileSync(planPath, JSON.stringify({
        version: 1,
        designCommitmentHash: hash('a'),
        analysisCommitmentHash: hash('b'),
        seedResourceCommitmentHash: hash('c'),
        predictionFunctionVersion: 'lv01-ledger-value-prediction/v1',
        partitionContractVersion: 'lv01-within-support/v1',
      }));
      const train = spawnSync(process.execPath, [
        'scripts/train-lv01-slot-parents.mjs', '--stage', 'development', '--version', version, '--run',
        '--slots', '1,2', '--parents-dir', parentsDir, '--store-root', storeRoot,
        '--track', 'scratch-rl', '--model-ref', 'gru-actor-critic-v1', '--learning-signal', 'extrinsic-task',
        '--max-turns', '4', '--evaluation-turns', '1', '--ledger-value-plan', planPath,
        '--deployment-mode', 'prototype', '--protocol-commit', 'git:test',
      ], { cwd: root, encoding: 'utf8' });
      if (train.status !== 0) console.log('TRAIN-FAIL stdout:', train.stdout, 'stderr:', train.stderr);
      expect(train.status).toBe(0);
      expect(existsSync(join(parentsDir, 'slot-0001'))).toBe(true);
      expect(existsSync(join(parentsDir, 'slot-0002'))).toBe(true);
      expect(existsSync(join(parentsDir, 'training-receipts.json'))).toBe(true);
      const collect = spawnSync(process.execPath, [
        'scripts/collect-lv01-stage.mjs', '--stage', 'development', '--version', version, '--run',
        '--per-slot-parents', '--evidence-dir', evidenceDir, '--partition', 'dev',
        '--ordinary-id', 'uniform', '--store-root', storeRoot, '--owner', 'lv01-cli-test',
      ], { cwd: root, encoding: 'utf8' });
      if (collect.status !== 0) console.log('COLLECT-FAIL stdout:', collect.stdout, 'stderr:', collect.stderr);
      expect(collect.status).toBe(0);
      expect(collect.stdout).toContain('collected: 2 cases');
      const audit = spawnSync(process.execPath, [
        'scripts/audit-lv01-stage.mjs', '--stage', 'development', '--version', version,
        '--live-evidence', '--evidence-dir', evidenceDir,
      ], { cwd: root, encoding: 'utf8' });
      if (audit.status !== 0) console.log('AUDIT-FAIL stdout:', audit.stdout, 'stderr:', audit.stderr);
      expect(audit.status).toBe(0);
      expect(audit.stdout).toContain('verified');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 300_000);
});
