import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS, PreRegistrationArtifactSchema } from '@ald/types';

import { compileE03Registration } from '../src/e03-registration.js';

const hash = (label: string) => hashCanonical(HASH_DOMAINS.scenarioBundle, label);

function baseConfig(primarySeeds = 3) {
  return buildRunConfig({
    runId: 'e03-registration-template',
    experimentId: 'E03',
    randomSeed: 'unrealized-seed',
    deploymentMode: 'research-grade',
    registrationClass: 'confirmatory',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    maxTurnsPerRun: 1,
    evaluationTurns: 200,
    evaluationSeeds: primarySeeds,
    scenarioBundleHash: hash('scenario'),
    promptBundleHash: hash('prompt'),
    protocolGitCommit: '1'.repeat(40),
    preRegistrationHash: hash('uncompiled-placeholder'),
  });
}

const input = {
  baseConfig: baseConfig(),
  hypothesis: 'E03 controls are equivalent to registered chance bounds.',
  analysisPlan: 'Apply Appendix D §D.6-§D.10 without outcome-dependent changes.',
  primarySeeds: 3,
} as const;

describe('E03 pre-registration compiler', () => {
  it('builds one canonical artifact and binds every condition/slot to its hash', () => {
    const result = compileE03Registration(input);
    expect(PreRegistrationArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
    expect(result.preRegistrationHash).toBe(
      hashCanonical(HASH_DOMAINS.preRegistration, result.artifact),
    );
    expect(result.runs).toHaveLength(24);
    expect(new Set(result.runs.map((run) => run.config.preRegistrationHash))).toEqual(
      new Set([result.preRegistrationHash]),
    );
    expect(new Set(result.runs.map((run) => run.condition)).size).toBe(6);
  });

  it('is byte-identical on repeat and changes hash when a registered field changes', () => {
    const first = compileE03Registration(input);
    const second = compileE03Registration(input);
    expect(second).toEqual(first);
    const changed = compileE03Registration({
      ...input,
      analysisPlan: `${input.analysisPlan} Sensitivity analysis added before registration.`,
    });
    expect(changed.preRegistrationHash).not.toBe(first.preRegistrationHash);
  });

  it('excludes realized run identity, seed, condition, and hash from the parameter template', () => {
    const result = compileE03Registration(input);
    const parameters = result.artifact.parameters;
    const template = parameters['runConfigTemplate'] as Record<string, unknown>;
    expect(template).not.toHaveProperty('runId');
    expect(template).not.toHaveProperty('randomSeed');
    expect(template).not.toHaveProperty('communicationCondition');
    expect(template).not.toHaveProperty('preRegistrationHash');
    expect(parameters['communicationConditions']).toEqual([
      'disabled',
      'constant',
      'random',
      'shuffled',
      'normal',
      'oracle',
    ]);
  });

  it('fails closed on a non-research or mismatched seed-count base', () => {
    expect(() =>
      compileE03Registration({
        ...input,
        baseConfig: { ...baseConfig(), deploymentMode: 'prototype' },
      }),
    ).toThrow(/research-grade/u);
    expect(() => compileE03Registration({ ...input, primarySeeds: 4 })).toThrow(
      /must equal primarySeeds/u,
    );
  });
});
