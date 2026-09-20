import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = ['protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/confirmatory-practical-margins.v1.json',
  'protocols/confirmatory-family-selection-amendment.v1.json',
  'protocols/statistical-analysis-and-power.v1.json',
  'protocols/seed-and-resource-allocation.v1.json'];

function fixture(mutate: (model: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-power-model-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.includes('power-model-amendment')) {
      const model = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(model); writeFileSync(target, `${JSON.stringify(model, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-power-model.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory power-model gate', () => {
  it('accepts the outcome-blind dependence-robust model', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects an independence-only selection authority', () => {
    const result = run(fixture((model) => { model.selectionAuthority = 'independent joint simulation'; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects weakening the H6b null boundary', () => {
    const result = run(fixture((model) => {
      const alternatives = model.designAlternatives as Array<{ id: string; nullBoundary: number }>;
      alternatives.find((entry) => entry.id === 'H6b')!.nullBoundary = 0.03;
    }));
    expect(result.status).not.toBe(0);
  });
});
