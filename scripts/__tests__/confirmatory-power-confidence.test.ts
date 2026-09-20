import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = ['protocols/confirmatory-power-confidence-amendment.v1.json',
  'protocols/confirmatory-power-model-amendment.v1.json',
  'protocols/confirmatory-family-selection-amendment.v1.json'];

function fixture(mutate: (value: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-power-confidence-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path); mkdirSync(dirname(target), { recursive: true });
    if (path.includes('power-confidence-amendment')) {
      const value = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(value); writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
    } else writeFileSync(target, readFileSync(join(root, path)));
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-power-confidence.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => { while (temporary.length) rmSync(temporary.pop()!, { recursive: true, force: true }); });

describe('confirmatory power-confidence gate', () => {
  it('accepts simultaneous member-power confidence', () => {
    expect(run(fixture()).status).toBe(0);
  });
  it('rejects unadjusted 95% member intervals', () => {
    const result = run(fixture((value) => { value.memberWilsonEquivalentTwoSidedConfidence = 0.95; }));
    expect(result.status).not.toBe(0);
  });
  it('rejects giving the joint diagnostic selection authority', () => {
    const result = run(fixture((value) => { value.jointDiagnosticAuthority = true; }));
    expect(result.status).not.toBe(0);
  });
});
