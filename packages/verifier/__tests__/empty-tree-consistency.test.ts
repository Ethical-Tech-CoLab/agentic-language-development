import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EMPTY_MERKLE_ROOT } from '@ald/merkle';
import { parseCanonicalJson } from '@ald/hashing';
import { ConsistencyProofSchema } from '@ald/types';

import { verifyBundleDetailed } from '../src/index.js';
import { buildFixtureBundle, type BuiltBundle } from './fixtures/build-bundle.js';
import { readFile } from 'node:fs/promises';

let fixture: BuiltBundle;

beforeAll(async () => {
  fixture = await buildFixtureBundle();
}, 60_000);

afterAll(async () => {
  await fixture.cleanup();
});

/**
 * Regression for the checkpoint/verifier integration gap found by the twin
 * route tests: checkpoint 0 is created before any turn, so the auxiliary
 * `turns` tree is absent from its manifest (LEDGER §8 omits size-0 auxiliary
 * trees). A consistency proof `turns-0-1.json` therefore spans `fromSize: 0`
 * and MUST verify (docs/evidence-bundle-format.md §6).
 */
describe('consistency proofs from a checkpoint that predates an auxiliary tree', () => {
  it('ships a fromSize-0 proof for the turns tree in the fixture', async () => {
    const file = join(fixture.bundleDir, 'proofs', 'consistency', 'turns-0-1.json');
    await expect(access(file)).resolves.toBeUndefined();
    const proof = ConsistencyProofSchema.parse(
      parseCanonicalJson((await readFile(file, 'utf8')).trimEnd()),
    );
    expect(proof.fromSize).toBe(0);
    expect(proof.fromRoot).toBe(EMPTY_MERKLE_ROOT);
    expect(proof.toSize).toBeGreaterThan(0);
  });

  it('verifies the bundle with consistency proofs valid and no tree-unknown gap', async () => {
    const { report } = await verifyBundleDetailed(fixture.bundleDir, {
      verifierVersion: 'test',
      now: () => '2026-09-07T00:00:00.000Z',
      writeReport: false,
    });
    expect(report.checks.consistencyProofsValid).toBe(true);
    expect(
      report.gaps.filter((gap) => gap.includes('consistency-proof-tree-unknown')),
    ).toEqual([]);
    expect(report.exitCode).toBe(0);
  });
});
