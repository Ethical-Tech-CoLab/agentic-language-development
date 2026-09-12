import { describe, expect, it } from 'vitest';

import { compileE03Registration } from '@ald/analysis';
import { hashCanonical } from '@ald/hashing';
import { buildRunConfig } from '@ald/lifecycle';
import { HASH_DOMAINS, type PreRegistrationBinding } from '@ald/types';

import {
  evaluateResearchPreflight,
  formatResearchPreflight,
} from '../src/research-preflight.js';

const COMMIT = '1'.repeat(40);
const hashed = (label: string) => hashCanonical(HASH_DOMAINS.scenarioBundle, label);

function registration() {
  const baseConfig = buildRunConfig({
    runId: 'e03-preflight',
    experimentId: 'E03',
    randomSeed: 'unrealized',
    deploymentMode: 'research-grade',
    registrationClass: 'confirmatory',
    babyA: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    babyB: { track: 'no-learning', modelRef: 'uniform-random-v1' },
    learningSignal: 'none',
    maxTurnsPerRun: 1,
    evaluationTurns: 200,
    evaluationSeeds: 3,
    scenarioBundleHash: hashed('scenario'),
    promptBundleHash: hashed('prompt'),
    protocolGitCommit: COMMIT,
    preRegistrationHash: hashed('draft'),
  });
  return compileE03Registration({
    baseConfig,
    hypothesis: 'Registered E03 hypothesis.',
    analysisPlan: 'Registered E03 analysis.',
    primarySeeds: 3,
  });
}

function passingInput() {
  const compiled = registration();
  const binding: PreRegistrationBinding = {
    registrationClass: 'confirmatory',
    preRegistrationHash: compiled.preRegistrationHash,
    externalRegistrationUrl: 'https://osf.io/example',
    externalRegistrationId: 'osf:e03-v1',
    registeredAt: '2026-09-09T00:00:00.000Z',
    preRunAnchor: {
      anchorClass: 'simulated',
      network: 'base-sepolia',
      chainId: 84532,
      transactionHash: `0x${'2'.repeat(64)}`,
      inputData: `0x${compiled.preRegistrationHash.slice(7)}`,
      blockNumber: 123,
      status: 'confirmed',
    },
    label: 'confirmatory: externally registered before run start',
  };
  return {
    config: compiled.runs[0]!.config,
    artifact: compiled.artifact,
    preRegistrationHash: compiled.preRegistrationHash,
    binding,
    repository: { headCommit: COMMIT, clean: true },
  };
}

describe('confirmatory research preflight', () => {
  it('passes only when every immutable input and external binding agrees', () => {
    const report = evaluateResearchPreflight(passingInput());
    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks.every((item) => item.pass)).toBe(true);
    expect(formatResearchPreflight(report)).toContain('Research preflight: READY');
  });

  it('reports every missing external prerequisite instead of stopping at the first', () => {
    const input = passingInput();
    const report = evaluateResearchPreflight({ ...input, binding: undefined });
    expect(report.ready).toBe(false);
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'binding-valid',
        'external-registration-complete',
        'binding-hash-matches',
        'pre-run-anchor-confirmed',
        'pre-run-anchor-network',
        'pre-run-anchor-payload',
      ]),
    );
    expect(formatResearchPreflight(report)).toContain('Research preflight: BLOCKED');
  });

  it.each([
    ['repository-clean', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      repository: { ...input.repository, clean: false },
    })],
    ['protocol-commit-immutable', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      repository: { ...input.repository, headCommit: '3'.repeat(40) },
    })],
    ['artifact-hash-matches', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      preRegistrationHash: hashed('other'),
    })],
    ['pre-run-anchor-payload', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      binding: {
        ...input.binding,
        preRunAnchor: { ...input.binding.preRunAnchor!, inputData: `0x${'4'.repeat(64)}` },
      },
    })],
    ['pre-run-anchor-network', (input: ReturnType<typeof passingInput>) => ({
      ...input,
      binding: {
        ...input.binding,
        preRunAnchor: { ...input.binding.preRunAnchor!, anchorClass: 'public-chain' as const },
      },
    })],
  ] as const)('fails the %s check independently', (id, mutate) => {
    expect(evaluateResearchPreflight(mutate(passingInput())).blockers).toContain(id);
  });
});
