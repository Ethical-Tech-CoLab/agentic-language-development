import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary: string[] = [];
const paths = [
  'protocols/confirmatory-practical-margins.v1.json',
  'protocols/research-protocol-cards.v1.json',
  'protocols/causal-ledger-and-leakage.v1.json',
  'protocols/confirmatory-design-readiness.v1.json',
];

function fixture(mutate: (policy: Record<string, unknown>) => void = () => undefined): string {
  const directory = mkdtempSync(join(tmpdir(), 'ald-practical-margins-'));
  temporary.push(directory);
  for (const path of paths) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    if (path.endsWith('confirmatory-practical-margins.v1.json')) {
      const policy = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>;
      mutate(policy);
      writeFileSync(target, `${JSON.stringify(policy, null, 2)}\n`);
    } else {
      writeFileSync(target, readFileSync(join(root, path)));
    }
  }
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [join(root, 'scripts/check-confirmatory-practical-margins.mjs')],
    { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

describe('confirmatory practical-margin policy gate', () => {
  it('accepts the source-bound outcome-blind policy', () => {
    const result = run(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/frozen outcome-blind/u);
  });

  it('rejects a claim that pilot data informed the margins', () => {
    const result = run(fixture((policy) => { policy.pilotDataInspected = true; }));
    expect(result.status).not.toBe(0);
  });

  it('rejects weakening the pre-existing H6b bound', () => {
    const result = run(fixture((policy) => {
      const members = policy.members as Array<{ id: string; margin: Record<string, number> }>;
      members.find((member) => member.id === 'H6b')!
        .margin.excessConditionalMutualInformationUpperBelowBits = 0.03;
    }));
    expect(result.status).not.toBe(0);
  });
});
