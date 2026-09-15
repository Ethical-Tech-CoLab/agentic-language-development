import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = join(root, 'scripts/check-e03-prototype-mode-amendment.mjs');
const directories: string[] = [];
const paths = [
  'protocols/e03-prototype-mode-amendment.v1.json',
  'protocols/e03-prototype-mode-amendment.v2.json',
  'SPECIFICATION.md',
  'packages/orchestrator/src/nursery-runtime.ts',
];

function fixture(mutate: (amendment: Record<string, any>) => void = () => undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'ald-e03-mode-amendment-'));
  directories.push(directory);
  for (const path of paths) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(root, path)));
  }
  const amendmentPath = join(directory, paths[1]!);
  const amendment = JSON.parse(readFileSync(amendmentPath, 'utf8'));
  mutate(amendment);
  writeFileSync(amendmentPath, `${JSON.stringify(amendment, null, 2)}\n`);
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('prospective E03 shared-process topology correction', () => {
  it('accepts the source-bound unexecuted design correction', () => {
    const result = fixture();
    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects restored external adapters under Prototype Mode', () => {
    const result = fixture((amendment) => {
      amendment.decision.physicalLearnerTransport = 'two-isolated-container-tcp-adapters';
    });
    expect(result.status).not.toBe(0);
  });

  it('rejects a changed control margin disguised as a topology correction', () => {
    const result = fixture((amendment) => {
      amendment.unchangedDesign.chanceEquivalenceBounds = [0.19, 0.31];
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('chanceEquivalenceBounds');
  });

  it('rejects a successor not bound to the exact predecessor', () => {
    const result = fixture((amendment) => {
      amendment.supersedes.sha256 = 'sha256:wrong';
    });
    expect(result.status).not.toBe(0);
  });
});
