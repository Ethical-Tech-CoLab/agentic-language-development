import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runBoundary(root: string) {
  return spawnSync(
    process.execPath,
    [join(process.cwd(), 'scripts', 'lint-crypto-boundary.mjs'), root],
    { encoding: 'utf8' },
  );
}

describe('ALD-070 import boundary', () => {
  it('accepts production crypto modules with no research-harness dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ald-crypto-boundary-clean-'));
    temporary.push(root);
    await mkdir(join(root, 'packages', 'hashing', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'anchor', 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'hashing', 'src', 'sign.ts'),
      "import { createHash } from 'node:crypto';\n",
    );

    const result = runBoundary(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('are isolated');
  });

  it('fails when hashing or anchoring imports the research harness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ald-crypto-boundary-bad-'));
    temporary.push(root);
    await mkdir(join(root, 'packages', 'hashing', 'src'), { recursive: true });
    await mkdir(join(root, 'packages', 'anchor', 'src'), { recursive: true });
    await writeFile(
      join(root, 'packages', 'anchor', 'src', 'publisher.ts'),
      "import { EphemeralEncodingHarness } from '@ald/crypto-research';\n",
    );

    const result = runBoundary(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/anchor/src/publisher.ts');
  });
});
