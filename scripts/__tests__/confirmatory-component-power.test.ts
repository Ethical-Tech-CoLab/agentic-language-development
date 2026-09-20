import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = ['protocols/confirmatory-component-power-amendment.v1.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/confirmatory-power-confidence-amendment.v1.json',
  'protocols/confirmatory-practical-margins.v1.json'];

function fixture(mutate: (value: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-component-power-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.includes('component-power-amendment')) {
      const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(value); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-component-power.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory component-power gate', () => {
  it('accepts component-wise dependence-robust selection', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects member-level confidence allocation', () => {
    const result = run(fixture((value) => { value.componentOneSidedAlpha = 0.05 / 9; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects joint diagnostic authority', () => {
    const result = run(fixture((value) => { value.diagnosticAuthority = 'controls selection'; }));
    expect(result.status).not.toBe(0);
  });
});
