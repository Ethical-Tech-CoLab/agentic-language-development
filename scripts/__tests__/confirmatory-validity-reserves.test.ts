import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = ['protocols/confirmatory-validity-reserve-amendment.v1.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/seed-and-resource-allocation.v1.json'];

function fixture(mutate: (value: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-validity-reserves-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.includes('validity-reserve-amendment')) {
      const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(value); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-validity-reserves.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory validity-reserve gate', () => {
  it('accepts the minimal prospective reserve table', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects a reserve count below the adequacy gate', () => {
    const result = run(fixture((value) => {
      const rows = value.zeroInvalidTwentySlotReference as Array<{ reserveSeeds: number }>;
      rows[0]!.reserveSeeds = 6;
    }));
    expect(result.status).not.toBe(0);
  });
  it('rejects pretending the amendment authorizes resources', () => {
    const result = run(fixture((value) => { value.resourceGate = 'resources authorized'; }));
    expect(result.status).not.toBe(0);
  });
});
