import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateConfirmatoryPowerSimulatorQualification } from
  '../check-confirmatory-power-simulator-qualification.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const receipt = JSON.parse(readFileSync(new URL(
  '../../reports/research/confirmatory-power-simulator-qualification-receipt.json', import.meta.url), 'utf8'));

function mutate(change: (copy: typeof receipt) => void) {
  const copy = structuredClone(receipt);
  change(copy);
  return copy;
}

describe('confirmatory power-simulator commit provenance', () => {
  it('rejects a forged tree for the named commit', () => {
    const forged = mutate((copy) => { copy.execution.tree = '0'.repeat(40); });
    expect(() => validateConfirmatoryPowerSimulatorQualification(forged, root)).toThrow(/tree must belong/u);
  });

  it('rejects a version not contained in the named commit', () => {
    const forged = mutate((copy) => { copy.execution.version = '0.1.999'; });
    expect(() => validateConfirmatoryPowerSimulatorQualification(forged, root)).toThrow(/version must belong/u);
  });

  it('rejects source bytes not contained in the named commit', () => {
    const forged = mutate((copy) => { copy.sourceArtifacts[0].sha256 = `sha256:${'0'.repeat(64)}`; });
    expect(() => validateConfirmatoryPowerSimulatorQualification(forged, root))
      .toThrow(/digest differs from the execution commit/u);
  });
});
