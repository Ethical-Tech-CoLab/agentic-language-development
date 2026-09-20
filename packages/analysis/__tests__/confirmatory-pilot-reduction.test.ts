import { describe, expect, it } from 'vitest';

import {
  CONFIRMATORY_PILOT_COMPONENTS,
  CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
  reduceConfirmatoryPilot,
  type ConfirmatoryPilotExperimentInput,
} from '../src/index.js';

function inputs(): ConfirmatoryPilotExperimentInput[] {
  return Object.entries(CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS).map(([id, memberIds], experimentIndex) => ({
    id: id as keyof typeof CONFIRMATORY_PILOT_EXPERIMENT_MEMBERS,
    registrationSha256: `sha256:${(experimentIndex + 1).toString(16).padStart(64, '0')}`,
    slots: Array.from({ length: 20 }, (_, index) => ({
      slot: index + 1,
      runId: `pilot-${id.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
      seed: `software-fixture-${id}-${index + 1}`,
      evidenceSha256: `sha256:${(1000 + experimentIndex * 20 + index).toString(16).padStart(64, '0')}`,
      components: Object.fromEntries(memberIds.map((memberId) => [memberId,
        Object.fromEntries(CONFIRMATORY_PILOT_COMPONENTS[memberId].map((componentId) =>
          [componentId, memberId === 'H5' ? index % 2 : index / 100]))])),
    })),
  }));
}

describe('confirmatory pilot numerical reduction', () => {
  it('reduces all seven complete corpora while withholding evidence admission', () => {
    const input = inputs();
    const result = reduceConfirmatoryPilot(input);
    expect(result).toEqual(reduceConfirmatoryPilot(input));
    expect(result.sourceInputSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.summary.experiments).toHaveLength(7);
    expect(result.summary.members).toHaveLength(9);
    expect(result.summary.members.flatMap((member) => member.components)).toHaveLength(14);
    expect(result.summary.members[0]?.components[0]?.sampleSd).toBeCloseTo(0.059160797830996162, 14);
    expect(result.summary.members[0]?.components[0]?.upper95Sd).toBeCloseTo(0.081074572482773596, 14);
    expect(result.summary.members[0]?.components[0]?.mean).toBeCloseTo(0.095, 14);
    expect(result.summary.members[4]?.components[0]?.mean).toBe(0.5);
    expect(result.summary.selectionEligible).toBe(true);
    expect(result.originalEvidenceVerified).toBe(false);
    expect(result.registrationAncestryVerified).toBe(false);
    expect(result.selectionAdmitted).toBe(false);
    expect(result.researchFinding).toBe(false);
  });

  it('rejects incomplete, reordered, or reused slots and registration identities', () => {
    const incomplete = inputs();
    (incomplete[0]!.slots as unknown[]).pop();
    expect(() => reduceConfirmatoryPilot(incomplete)).toThrow(/twenty valid/u);
    const reordered = inputs();
    (reordered[0]!.slots[0] as { slot: number }).slot = 2;
    expect(() => reduceConfirmatoryPilot(reordered)).toThrow(/slot identities/u);
    const reused = inputs();
    (reused[1]!.slots[0] as { seed: string }).seed = reused[0]!.slots[0]!.seed;
    expect(() => reduceConfirmatoryPilot(reused)).toThrow(/slot identities/u);
    const duplicateRegistration = inputs();
    (duplicateRegistration[1] as { registrationSha256: string }).registrationSha256 =
      duplicateRegistration[0]!.registrationSha256;
    expect(() => reduceConfirmatoryPilot(duplicateRegistration)).toThrow(/distinct registrations/u);
  });

  it('rejects missing components, malformed evidence, and nonbinary H5 indicators', () => {
    const missing = inputs();
    delete (missing[0]!.slots[0]!.components.H1 as Record<string, unknown>).disabled;
    expect(() => reduceConfirmatoryPilot(missing)).toThrow(/exact ordered registered keys/u);
    const malformed = inputs();
    (malformed[0]!.slots[0] as { evidenceSha256: string }).evidenceSha256 = 'not-a-digest';
    expect(() => reduceConfirmatoryPilot(malformed)).toThrow(/slot identities/u);
    const binary = inputs();
    (binary[1]!.slots[0]!.components.H5 as Record<string, number>)['stable-acquisition'] = 0.2;
    expect(() => reduceConfirmatoryPilot(binary)).toThrow(/is invalid/u);
  });
});
