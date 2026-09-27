import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../lv01.mjs', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

const FIXTURE_VERSION = '101';
const fixturePaths = (stage: string, version: string): string[] => [
  `protocols/lv01-${stage}-resource-allocation.v${version}.json`,
  `protocols/lv01-${stage}-registration.v${version}.json`,
  `protocols/lv01-${stage}-registration-binding.v${version}.json`,
  `reports/research/lv01-topology-qualification.v${version}.json`,
  `reports/research/lv01-${stage}-gate-receipt.v${version}.json`,
];
const cleanFixtures = (stage: string, version: string): void => {
  for (const path of fixturePaths(stage, version)) rmSync(join(root, path), { force: true });
};
const writeGateFixtures = (stage: string, version: string): void => {
  writeFileSync(
    join(root, `protocols/lv01-${stage}-resource-allocation.v${version}.json`),
    '{"schemaVersion": 1, "studyId": "LV01", "status": "design-locked-not-executed"}\n',
  );
  writeFileSync(
    join(root, `reports/research/lv01-topology-qualification.v${version}.json`),
    '{"schemaVersion": 1, "studyId": "LV01", "passed": true}\n',
  );
};
const trackedTreeClean = (): boolean =>
  spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).stdout.trim() === '';

afterEach(() => {
  cleanFixtures('development', FIXTURE_VERSION);
  cleanFixtures('confirmatory', '102');
});

describe('LV01 execution CLI', () => {
  it('reports the evidenced not-ready state without writing a receipt', () => {
    const result = run('status', '--live-evidence');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"executionReadiness": "blocked"');
    expect(result.stdout).toContain('"scientificDisposition": "not-tested"');
  });

  it('rejects a pilot collection that has no prospective packet', () => {
    const result = run('collect', '--stage', 'pilot', '--version', '1', '--run');
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
    expect(run('check-design', '--version', '3').status).not.toBe(0);
    expect(run('check-design').status).not.toBe(0);
  });

  it('stops main stages without a locked design receipt', () => {
    writeGateFixtures('confirmatory', '102');
    const result = run('compile', '--stage', 'confirmatory', '--version', '102', '--write');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('locked design receipt');
  });

  it('compiles, binds, and admits a stage, and refuses rewrites and early collection', () => {
    writeGateFixtures('development', FIXTURE_VERSION);
    if (!trackedTreeClean()) {
      const result = run('compile', '--stage', 'development', '--version', FIXTURE_VERSION, '--write');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('clean tracked tree');
      return;
    }
    const compiled = run('compile', '--stage', 'development', '--version', FIXTURE_VERSION, '--write');
    expect(compiled.status).toBe(0);
    expect(compiled.stdout).toContain('registered: sha256:');
    expect(run('compile', '--stage', 'development', '--version', FIXTURE_VERSION, '--write').status).not.toBe(0);
    const bound = run('bind', '--stage', 'development', '--version', FIXTURE_VERSION, '--write');
    expect(bound.status).toBe(0);
    expect(bound.stdout).toContain('bound: sha256:');
    const early = run('collect', '--stage', 'development', '--version', FIXTURE_VERSION, '--run');
    expect(early.status).not.toBe(0);
    expect(early.stderr).toContain('no admitted immutable receipt');
    const admitted = run('admit', '--stage', 'development', '--version', FIXTURE_VERSION, '--live-evidence');
    expect(admitted.status).toBe(0);
    expect(admitted.stdout).toContain('admission: ready');
    const receiptPath = join(root, `reports/research/lv01-development-gate-receipt.v${FIXTURE_VERSION}.json`);
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({ status: 'ready', reasons: [] });
  });
});
