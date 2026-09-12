import { describe, expect, it } from 'vitest';

import {
  REGISTRATION_BINDING_KEYS,
  compileRegistrationPacket,
  type CompileRegistrationPacketInput,
} from '../src/index.js';

function input(): CompileRegistrationPacketInput {
  return {
    experimentId: 'E16',
    registrationClass: 'confirmatory',
    bindings: {
      protocolCard: { version: 1, sha256: 'a'.repeat(64) },
      runConfigurations: [{ condition: 'normal', sha256: 'b'.repeat(64) }],
      practicalMargins: { h2Probability: 0.05, h4Brier: 0.02 },
      analysisVersions: ['e16-causal-prediction-pipeline/v1'],
      modelAssets: [{ role: 'receiver', sha256: 'c'.repeat(64) }],
      selectedSeedPrefix: { stage: 'confirmatory', primary: ['seed-001'], reserve: ['seed-002'] },
      executionHost: { manifestSha256: 'd'.repeat(64), topology: 'mode-r' },
      scenarioBundle: { sha256: 'e'.repeat(64), splits: ['train', 'validation', 'test'] },
      exclusionRules: ['integrity failure', 'configuration mismatch'],
      stoppingRules: { outcomeDependent: false, maximumTurns: 1000 },
      evidenceAndAnchorPolicy: { chainId: 8453, confirmations: 20, verifier: 'ald-verify' },
    },
  };
}

describe('canonical registration packet', () => {
  it('binds every required operational field in fixed order', () => {
    const result = compileRegistrationPacket(input());
    expect(result.artifact.bindings.map((binding) => binding.key)).toEqual(REGISTRATION_BINDING_KEYS);
    expect(result.artifact.bindings.every((binding) => binding.sha256.startsWith('sha256:'))).toBe(true);
    expect(JSON.parse(result.canonicalArtifact)).toEqual(result.artifact);
    expect(result.preRegistrationHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.claimBoundary).toBe('draft-until-repository-registered-and-pre-run-committed');
  });

  it('is deterministic and changes when any bound content changes', () => {
    const first = compileRegistrationPacket(input());
    expect(compileRegistrationPacket(input())).toEqual(first);
    const changed = input();
    changed.bindings.practicalMargins = { h2Probability: 0.06, h4Brier: 0.02 };
    expect(compileRegistrationPacket(changed).preRegistrationHash).not.toBe(first.preRegistrationHash);
  });

  it('rejects missing, extra, empty, and placeholder bindings', () => {
    const missing = input();
    delete (missing.bindings as Partial<typeof missing.bindings>).executionHost;
    expect(() => compileRegistrationPacket(missing)).toThrow(/must contain exactly/u);

    const extra = input() as CompileRegistrationPacketInput & { bindings: Record<string, unknown> };
    extra.bindings['outcomes'] = ['forbidden'];
    expect(() => compileRegistrationPacket(extra)).toThrow(/must contain exactly/u);

    const empty = input();
    empty.bindings.analysisVersions = [];
    expect(() => compileRegistrationPacket(empty)).toThrow(/empty array/u);

    const placeholder = input();
    placeholder.bindings.executionHost = { manifestSha256: 'TBD' };
    expect(() => compileRegistrationPacket(placeholder)).toThrow(/placeholder/u);
  });

  it('rejects invalid experiment identity and non-finite numeric fields', () => {
    expect(() => compileRegistrationPacket({ ...input(), experimentId: 'experiment-16' })).toThrow(/form E00/u);
    const invalidNumber = input();
    invalidNumber.bindings.stoppingRules = { maximumTurns: Number.NaN };
    expect(() => compileRegistrationPacket(invalidNumber)).toThrow(/finite/u);
  });
});
