import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const required = [
  'protocols/lv01-study-design.v1.json',
  'protocols/lv01-analysis-plan.v1.json',
  'protocols/lv01-seed-resource-policy.v1.json',
  'protocols/research-protocol-cards.v1.json',
  'protocols/scenario-split-and-model-comparison.v1.json',
  'protocols/causal-ledger-and-leakage.v1.json',
  'protocols/confirmatory-practical-margins.v1.json',
  'protocols/seed-and-resource-allocation.v1.json',
];

function fixture(change?: (design: Record<string, unknown>) => void): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-lv01-design-'));
  temporary.push(directory);
  for (const source of required) {
    const target = join(directory, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, source), target);
  }
  if (change !== undefined) {
    const target = join(directory, 'protocols/lv01-study-design.v1.json');
    const design = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    change(design);
    writeFileSync(target, `${JSON.stringify(design, null, 2)}\n`);
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-lv01-design.mjs')], {
    cwd: directory,
    encoding: 'utf8',
  });
}

afterEach(() => { while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('LV01 design contract', () => {
  it('accepts the frozen outcome-blind contract', () => expect(run(fixture()).status).toBe(0));
  it('rejects a changed training budget', () => {
    const result = run(fixture((design) => {
      ((design.task as Record<string, unknown>).partitions as Record<string, Record<string, unknown>>).training.cases = 2999;
    }));
    expect(result.status).not.toBe(0);
  });
  it('rejects source-policy drift', () => {
    const directory = fixture();
    const source = join(directory, 'protocols/research-protocol-cards.v1.json');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n`);
    expect(run(directory).status).not.toBe(0);
  });
});
