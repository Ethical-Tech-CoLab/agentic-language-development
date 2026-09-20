import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = [
  'protocols/confirmatory-pilot-reduction.v1.json',
  'protocols/confirmatory-design-readiness.v1.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/confirmatory-practical-margins.v1.json',
  'packages/analysis/src/confirmatory-pilot.ts',
  'packages/analysis/src/confirmatory-pilot-reduction.ts',
];

function fixture(mutate: (value: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-pilot-reduction-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.endsWith('confirmatory-pilot-reduction.v1.json')) {
      const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(value); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-pilot-reduction.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory pilot reduction policy gate', () => {
  it('accepts the complete prospective policy and independent R factor', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects a smaller upper-SD factor', () => {
    const result = run(fixture((value) => {
      (value.upperDispersion as { factor: number }).factor = 1;
    }));
    expect(result.status).not.toBe(0);
  });
  it('rejects missing slot requirements', () => {
    const result = run(fixture((value) => { value.totalRequiredPrimarySlots = 139; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects permitting pilot means to tune the design', () => {
    const result = run(fixture((value) => { value.designUse = 'pilot means may change margins'; }));
    expect(result.status).not.toBe(0);
  });
});
