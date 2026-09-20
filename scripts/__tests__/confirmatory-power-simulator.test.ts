import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = [
  'protocols/confirmatory-power-simulator.v1.json',
  'protocols/confirmatory-component-power-amendment.v1.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/confirmatory-practical-margins.v1.json',
  'protocols/confirmatory-validity-reserve-amendment.v1.json',
  'packages/analysis/src/confirmatory-power-simulation.ts',
];

function fixture(mutate: (value: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-power-simulator-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.endsWith('confirmatory-power-simulator.v1.json')) {
      const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(value); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-power-simulator.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory power-simulator gate', () => {
  it('accepts the prospective deterministic specification', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects a reduced Monte Carlo count', () => {
    const result = run(fixture((value) => { value.repetitionsPerCandidate = 3000; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects joint diagnostic selection authority', () => {
    const result = run(fixture((value) => { value.selectionAuthority = 'joint output selects N'; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects laundering fixtures into a campaign result', () => {
    const result = run(fixture((value) => { value.qualificationRule = 'fixture selects campaign N'; }));
    expect(result.status).not.toBe(0);
  });
});
