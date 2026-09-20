import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateConfirmatoryPilotReductionQualification } from
  '../qualify-confirmatory-pilot-reduction.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const receipt = JSON.parse(readFileSync(new URL(
  '../../reports/research/confirmatory-pilot-reduction-qualification-receipt.json',
  import.meta.url), 'utf8'));
const mutate = (change: (copy: typeof receipt) => void) => {
  const copy = structuredClone(receipt);
  change(copy);
  return copy;
};

describe('confirmatory pilot-reduction qualification provenance', () => {
  it('rejects a forged execution tree or package version', () => {
    expect(() => validateConfirmatoryPilotReductionQualification(mutate((copy) => {
      copy.execution.tree = '0'.repeat(40);
    }), root)).toThrow();
    expect(() => validateConfirmatoryPilotReductionQualification(mutate((copy) => {
      copy.execution.version = '0.1.999';
    }), root)).toThrow();
  });

  it('rejects altered committed source and output digests', () => {
    expect(() => validateConfirmatoryPilotReductionQualification(mutate((copy) => {
      copy.sourceArtifacts[0].sha256 = `sha256:${'0'.repeat(64)}`;
    }), root)).toThrow();
    expect(() => validateConfirmatoryPilotReductionQualification(mutate((copy) => {
      copy.qualification.outputSha256 = `sha256:${'0'.repeat(64)}`;
    }), root)).toThrow();
  });

  it('refuses promotion of synthetic fixture output to admitted pilot evidence', () => {
    expect(() => validateConfirmatoryPilotReductionQualification(mutate((copy) => {
      copy.selectionAdmitted = true;
    }), root)).toThrow();
  });
});
