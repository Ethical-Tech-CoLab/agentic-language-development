import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error The retained-evidence auditor is a directly executable ESM script.
import { validateLv01DevelopmentV23Receipt } from '../check-lv01-development-v23-receipt.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const receiptPath = new URL('../../reports/research/lv01-development-v23-receipt.json', import.meta.url);
const original = JSON.parse(readFileSync(receiptPath, 'utf8'));
const mutate = (change: (copy: typeof original) => void) => {
  const copy = structuredClone(original);
  change(copy);
  return copy;
};

describe('LV01 v23 portable fixture receipt boundary', () => {
  it('accepts the retained bounded fixture summary', () => {
    expect(() => validateLv01DevelopmentV23Receipt(original)).not.toThrow();
  });

  const mutations = [
    ['research claim', (r: typeof original) => { r.researchFinding = true; }],
    ['tested disposition', (r: typeof original) => { r.scientificDisposition = 'tested'; }],
    ['unsealed state', (r: typeof original) => { r.observed.state = 'open'; }],
    ['training turns', (r: typeof original) => { r.observed.trainingTurns = 63; }],
    ['evaluation turns', (r: typeof original) => { r.observed.evaluationTurns = 23; }],
    ['checkpoint count', (r: typeof original) => { r.observed.checkpointCount = 11; }],
    ['verifier exit code', (r: typeof original) => { r.observed.offlineVerifierExitCode = 1; }],
    ['resource samples', (r: typeof original) => { r.observed.resourceSamples = 0; }],
    ['service count', (r: typeof original) => { r.observed.serviceCount = 16; }],
    ['denied probes', (r: typeof original) => { r.observed.deniedPrivateModelAccessProbes = 0; }],
    ['ledger size', (r: typeof original) => { r.observed.finalVerifiedSizes['baby-a-ledger'] = 0; }],
    ['forged retained hash', (r: typeof original) => { r.attempt.retainedFiles[0].sha256 = `sha256:${'0'.repeat(64)}`; }],
    ['missing limitation', (r: typeof original) => { r.limitations = []; }],
    ['missing claim boundary', (r: typeof original) => { r.claimBoundary = ''; }],
  ] as const;
  it.each(mutations)('rejects %s', (_name, change) => {
    expect(() => validateLv01DevelopmentV23Receipt(mutate(change))).toThrow();
  });

  it('verifies the tracked receipt against retained local evidence', () => {
    const result = spawnSync(process.execPath,
      ['scripts/check-lv01-development-v23-receipt.mjs'], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('verified against retained local evidence');
  });
});
