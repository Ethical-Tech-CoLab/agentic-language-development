import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@ald/hashing';
import {
  GENESIS_HASH,
  HASH_DOMAINS,
  type LearnerTrackId,
  type RunConfig,
} from '@ald/types';
import {
  RUN_CONFIG_DEFAULTS,
  RunConfigValidationError,
  buildRunConfig,
  hashRunConfig,
  validateRunConfig,
  type RunConfigError,
  type RunConfigOverrides,
} from '@ald/lifecycle';

const BASE: RunConfigOverrides = {
  runId: 'run-0001',
  experimentId: 'E00',
  randomSeed: 'seed-0001',
};

const TRACKS: LearnerTrackId[] = [
  'frozen-llm',
  'scratch-rl',
  'self-supervised',
  'hybrid',
  'no-learning',
];

const RL_SIGNALS: RunConfig['learningSignal'][] = [
  'extrinsic-task',
  'intrinsic-social-influence',
  'intrinsic-curiosity',
  'intrinsic-prediction-progress',
  'intrinsic-giddiness',
];

const CARRIERS: RunConfig['carrierMode'][] = [
  'fixed-token',
  'fixed-glyph',
  'generative-bitmap',
  'generative-canvas',
  'generative-tone',
];

const AFFECT_MODES: RunConfig['affectMode'][] = [
  'none',
  'declared',
  'permuted',
  'opaque',
  'derived',
  'emergent',
];

const INTERACTION_MODES: RunConfig['interactionMode'][] = [
  'cooperative-signaling',
  'asymmetric-information',
  'semi-cooperative-negotiation',
  'conflicting-negotiation',
  'no-agreement-control',
];

const COMMUNICATION_CONDITIONS: RunConfig['communicationCondition'][] = [
  'normal',
  'disabled',
  'constant',
  'random',
  'shuffled',
  'oracle',
];

function errorsOf(input: unknown): RunConfigError[] {
  const result = validateRunConfig(input);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

function paths(input: unknown): string[] {
  return errorsOf(input).map((error) => error.path);
}

function valid(config: RunConfig): { configurationHash: string; warnings: string[] } {
  const result = validateRunConfig(config);
  if (!result.ok) {
    throw new Error(
      `expected a valid config, got: ${result.errors
        .map((error) => `${error.path}: ${error.message}`)
        .join('; ')}`,
    );
  }
  return { configurationHash: result.configurationHash, warnings: result.warnings };
}

describe('buildRunConfig defaults (SPEC §18)', () => {
  const config = buildRunConfig(BASE);

  it('fills every §18 default', () => {
    expect(config).toEqual({
      version: 1,
      runId: 'run-0001',
      experimentId: 'E00',
      randomSeed: 'seed-0001',
      deploymentMode: 'prototype',
      babyA: {
        track: 'scratch-rl',
        modelRef: 'tabular-reinforce-v1',
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'scratch-rl',
        modelRef: 'tabular-reinforce-v1',
        trainingIsolation: 'independent',
      },
      symmetricTracks: true,
      learningSignal: 'extrinsic-task',
      communicationCondition: 'normal',
      interactionMode: 'cooperative-signaling',
      carrierMode: 'fixed-token',
      symbolInventorySize: 32,
      maxSymbolsPerMessage: 4,
      affectMode: 'none',
      affectWindowSchedule: 'post-outcome',
      observationEncoding: 'opaque-numeric',
      roleReversalPeriod: 1,
      turnResponseBudgetMs: 30_000,
      maxTurnsPerRun: 200,
      maxConsecutiveRejections: 5,
      ledgerLagTurns: 0,
      curriculumMode: 'fixed-schedule',
      cipherThreatModel: 'post-run-disclosure',
      interventionSuiteThreshold: 0.7,
      evaluationSeeds: 5,
      checkpointEventInterval: 64,
      checkpointTimeIntervalMs: 300_000,
      anchorNetwork: 'base-sepolia',
      finalityPolicy: '1-confirmation',
      prototypeRetentionDays: 30,
      scenarioBundleHash: GENESIS_HASH,
      promptBundleHash: GENESIS_HASH,
      preRegistrationHash: GENESIS_HASH,
      protocolGitCommit: 'unknown',
    });
  });

  it('omits lineage, maxStrokes, and derived-only fields for a root run', () => {
    expect(config.parentRunId).toBeUndefined();
    expect(config.derivedFromCheckpointHash).toBeUndefined();
    expect(config.babyA.initialPolicyRef).toBeUndefined();
    expect(config.maxStrokes).toBeUndefined();
    expect(Object.keys(config)).not.toContain('maxStrokes');
  });

  it('validates its own output and reports no warnings', () => {
    const { warnings } = valid(config);
    expect(warnings).toEqual([]);
  });

  it('exposes the defaults it used', () => {
    expect(RUN_CONFIG_DEFAULTS.symbolInventorySize).toBe(32);
    expect(RUN_CONFIG_DEFAULTS.maxSymbolsPerMessage).toBe(4);
    expect(RUN_CONFIG_DEFAULTS.maxStrokes).toBe(8);
    expect(RUN_CONFIG_DEFAULTS.placeholderHash).toBe(GENESIS_HASH);
  });

  it('honours explicit overrides, including placeholders', () => {
    const overridden = buildRunConfig({
      ...BASE,
      protocolGitCommit: 'a'.repeat(40),
      maxTurnsPerRun: 12,
      turnResponseBudgetMs: 5_000,
      preRegistrationHash: `sha256:${'1'.repeat(64)}`,
    });
    expect(overridden.protocolGitCommit).toBe('a'.repeat(40));
    expect(overridden.maxTurnsPerRun).toBe(12);
    expect(overridden.turnResponseBudgetMs).toBe(5_000);
    expect(overridden.preRegistrationHash).toBe(`sha256:${'1'.repeat(64)}`);
  });
});

describe('carrier-scoped defaults (SPEC §11.1, §9.1, §9.2)', () => {
  it('populates the fixed-token bounds only for fixed-token', () => {
    const fixedToken = buildRunConfig({ ...BASE, carrierMode: 'fixed-token' });
    expect(fixedToken.symbolInventorySize).toBe(32);
    expect(fixedToken.maxSymbolsPerMessage).toBe(4);
    expect(fixedToken.maxStrokes).toBeUndefined();

    for (const carrierMode of CARRIERS.filter(
      (carrier) => carrier !== 'fixed-token',
    )) {
      const config = buildRunConfig({ ...BASE, carrierMode });
      expect(config.symbolInventorySize).toBeUndefined();
      expect(config.maxSymbolsPerMessage).toBeUndefined();
    }
  });

  it('populates maxStrokes only for generative-canvas', () => {
    const canvas = buildRunConfig({ ...BASE, carrierMode: 'generative-canvas' });
    expect(canvas.maxStrokes).toBe(8);
    for (const carrierMode of CARRIERS.filter(
      (carrier) => carrier !== 'generative-canvas',
    )) {
      expect(buildRunConfig({ ...BASE, carrierMode }).maxStrokes).toBeUndefined();
    }
  });

  it('builds a valid config for every carrier mode', () => {
    for (const carrierMode of CARRIERS) {
      valid(buildRunConfig({ ...BASE, carrierMode }));
    }
  });
});

describe('track and learning-signal matrix (SPEC §11.1)', () => {
  it('accepts the defaulted signal for every symmetric track', () => {
    const expected: Record<LearnerTrackId, RunConfig['learningSignal']> = {
      'frozen-llm': 'none',
      'no-learning': 'none',
      'self-supervised': 'self-supervised',
      'scratch-rl': 'extrinsic-task',
      hybrid: 'extrinsic-task',
    };

    for (const track of TRACKS) {
      const config = buildRunConfig({
        ...BASE,
        babyA: { track },
        babyB: { track },
      });
      expect(config.learningSignal).toBe(expected[track]);
      expect(config.symmetricTracks).toBe(true);
      valid(config);
    }
  });

  it('accepts scratch-rl with the extrinsic signal and every named intrinsic signal', () => {
    for (const learningSignal of RL_SIGNALS) {
      valid(
        buildRunConfig({
          ...BASE,
          babyA: { track: 'scratch-rl' },
          babyB: { track: 'scratch-rl' },
          learningSignal,
        }),
      );
    }
  });

  it('accepts hybrid with any RL-compatible or self-supervised signal', () => {
    for (const learningSignal of [...RL_SIGNALS, 'self-supervised' as const]) {
      valid(
        buildRunConfig({
          ...BASE,
          babyA: { track: 'hybrid' },
          babyB: { track: 'hybrid' },
          learningSignal,
        }),
      );
    }
  });

  it('accepts asymmetric tracks when symmetricTracks is false', () => {
    const config = buildRunConfig({
      ...BASE,
      babyA: { track: 'scratch-rl' },
      babyB: { track: 'hybrid' },
      learningSignal: 'extrinsic-task',
    });
    expect(config.symmetricTracks).toBe(false);
    valid(config);
  });

  it('rejects no-learning with extrinsic-task on both Babies', () => {
    const config = {
      ...buildRunConfig({ ...BASE, babyA: { track: 'scratch-rl' } }),
      babyA: {
        track: 'no-learning',
        modelRef: 'none',
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'no-learning',
        modelRef: 'none',
        trainingIsolation: 'independent',
      },
      learningSignal: 'extrinsic-task',
    };
    const reported = paths(config);
    expect(reported).toContain('babyA.track');
    expect(reported).toContain('babyB.track');
    expect(errorsOf(config)[0]?.message).toContain('no-learning');
  });

  it('rejects frozen-llm with a non-none signal', () => {
    const config = {
      ...buildRunConfig({ ...BASE, babyA: { track: 'frozen-llm' }, babyB: { track: 'frozen-llm' } }),
      learningSignal: 'intrinsic-curiosity',
    };
    expect(paths(config)).toContain('babyA.track');
  });

  it('rejects scratch-rl with learningSignal none', () => {
    const config = { ...buildRunConfig(BASE), learningSignal: 'none' };
    const reported = paths(config);
    expect(reported).toContain('babyA.track');
    expect(reported).toContain('babyB.track');
  });

  it('rejects self-supervised with extrinsic-task', () => {
    const config = {
      ...buildRunConfig({
        ...BASE,
        babyA: { track: 'self-supervised' },
        babyB: { track: 'self-supervised' },
      }),
      learningSignal: 'extrinsic-task',
    };
    expect(paths(config)).toContain('babyA.track');
  });

  it('rejects hybrid with learningSignal none', () => {
    const config = {
      ...buildRunConfig({
        ...BASE,
        babyA: { track: 'hybrid' },
        babyB: { track: 'hybrid' },
      }),
      learningSignal: 'none',
    };
    const reported = errorsOf(config);
    expect(reported.map((error) => error.path)).toContain('babyA.track');
    expect(
      reported.some((error) => /hybrid must declare/u.test(error.message)),
    ).toBe(true);
  });

  it('throws from buildRunConfig for a mixed learning/no-learning pair', () => {
    expect(() =>
      buildRunConfig({
        ...BASE,
        babyA: { track: 'scratch-rl' },
        babyB: { track: 'no-learning' },
      }),
    ).toThrow(RunConfigValidationError);
  });
});

describe('symmetricTracks agreement (SPEC §18)', () => {
  it('rejects symmetricTracks false with identical tracks', () => {
    const config = { ...buildRunConfig(BASE), symmetricTracks: false };
    expect(paths(config)).toContain('symmetricTracks');
    expect(errorsOf(config)[0]?.message).toContain(
      'symmetricTracks must be true when both Babies use track "scratch-rl"',
    );
  });

  it('rejects symmetricTracks true with different tracks', () => {
    const built = buildRunConfig({
      ...BASE,
      babyA: { track: 'scratch-rl' },
      babyB: { track: 'hybrid' },
    });
    const config = { ...built, symmetricTracks: true };
    expect(paths(config)).toContain('symmetricTracks');
    expect(errorsOf(config)[0]?.message).toContain(
      'symmetricTracks must be false when babyA uses "scratch-rl"',
    );
  });
});

describe('carrier-specific field rules (SPEC §11.1)', () => {
  it('rejects symbolInventorySize and maxSymbolsPerMessage on another carrier', () => {
    const base = buildRunConfig({ ...BASE, carrierMode: 'fixed-glyph' });
    expect(paths({ ...base, symbolInventorySize: 32 })).toEqual([
      'symbolInventorySize',
    ]);
    expect(paths({ ...base, maxSymbolsPerMessage: 4 })).toEqual([
      'maxSymbolsPerMessage',
    ]);
    expect(
      paths({ ...base, symbolInventorySize: 32, maxSymbolsPerMessage: 4 }),
    ).toEqual(['symbolInventorySize', 'maxSymbolsPerMessage']);
  });

  it('rejects maxStrokes outside generative-canvas', () => {
    expect(paths({ ...buildRunConfig(BASE), maxStrokes: 8 })).toEqual([
      'maxStrokes',
    ]);
    valid(
      buildRunConfig({
        ...BASE,
        carrierMode: 'generative-canvas',
        maxStrokes: 12,
      }),
    );
  });

  it('rejects maxSymbolsPerMessage above the Gateway ceiling of 16', () => {
    expect(paths({ ...buildRunConfig(BASE), maxSymbolsPerMessage: 17 })).toEqual(
      ['maxSymbolsPerMessage'],
    );
    valid(buildRunConfig({ ...BASE, maxSymbolsPerMessage: 16 }));
  });

  it('rejects a symbol inventory outside 2-256', () => {
    expect(paths({ ...buildRunConfig(BASE), symbolInventorySize: 1 })).toEqual([
      'symbolInventorySize',
    ]);
    expect(paths({ ...buildRunConfig(BASE), symbolInventorySize: 257 })).toEqual(
      ['symbolInventorySize'],
    );
  });
});

describe('experiment and mode coverage (ALD-023)', () => {
  it('restricts the oracle condition to E03', () => {
    valid(
      buildRunConfig({
        ...BASE,
        experimentId: 'E03',
        communicationCondition: 'oracle',
      }),
    );
    expect(() =>
      buildRunConfig({
        ...BASE,
        experimentId: 'E11',
        communicationCondition: 'oracle',
        evaluationSeeds: 10,
      }),
    ).toThrow(RunConfigValidationError);
    const config = {
      ...buildRunConfig({ ...BASE, experimentId: 'E11', evaluationSeeds: 10 }),
      communicationCondition: 'oracle',
    };
    expect(paths(config)).toContain('communicationCondition');
  });

  it('builds a valid config for every communication condition', () => {
    for (const communicationCondition of COMMUNICATION_CONDITIONS) {
      valid(
        buildRunConfig({
          ...BASE,
          experimentId: communicationCondition === 'oracle' ? 'E03' : 'E00',
          communicationCondition,
        }),
      );
    }
  });

  it('builds a valid config for every affect, interaction, observation, and deployment mode', () => {
    for (const affectMode of AFFECT_MODES) {
      valid(buildRunConfig({ ...BASE, affectMode }));
    }
    for (const interactionMode of INTERACTION_MODES) {
      valid(buildRunConfig({ ...BASE, interactionMode }));
    }
    for (const observationEncoding of [
      'opaque-numeric',
      'pixel',
      'hybrid-features',
    ] as const) {
      valid(buildRunConfig({ ...BASE, observationEncoding }));
    }
    for (const deploymentMode of ['prototype', 'research-grade'] as const) {
      valid(buildRunConfig({ ...BASE, deploymentMode }));
    }
    for (const curriculumMode of ['fixed-schedule', 'adaptive-guided'] as const) {
      valid(buildRunConfig({ ...BASE, curriculumMode }));
    }
    for (const anchorNetwork of ['base-sepolia', 'base-mainnet'] as const) {
      valid(buildRunConfig({ ...BASE, anchorNetwork }));
    }
  });

  it('rejects a malformed experiment identifier', () => {
    expect(paths({ ...buildRunConfig(BASE), experimentId: 'X1' })).toEqual([
      'experimentId',
    ]);
  });
});

describe('missing and malformed input (ALD-023)', () => {
  it('rejects non-objects', () => {
    expect(errorsOf(undefined).length).toBeGreaterThan(0);
    expect(errorsOf(null).length).toBeGreaterThan(0);
    expect(errorsOf('run').length).toBeGreaterThan(0);
    expect(errorsOf(42).length).toBeGreaterThan(0);
  });

  it('reports each missing required field by path', () => {
    const config: Record<string, unknown> = { ...buildRunConfig(BASE) };
    for (const field of [
      'runId',
      'randomSeed',
      'deploymentMode',
      'carrierMode',
      'babyA',
      'maxTurnsPerRun',
      'scenarioBundleHash',
      'protocolGitCommit',
    ]) {
      const incomplete = { ...config };
      delete incomplete[field];
      expect(paths(incomplete)).toContain(field);
    }
  });

  it('reports a nested learner field by dotted path', () => {
    const config = buildRunConfig(BASE);
    const broken = {
      ...config,
      babyA: { track: 'scratch-rl', trainingIsolation: 'independent' },
    };
    expect(paths(broken)).toContain('babyA.modelRef');
  });

  it('rejects an unknown version', () => {
    expect(paths({ ...buildRunConfig(BASE), version: 2 })).toEqual(['version']);
  });
});

describe('derived-run lineage fields are all-or-none (SPEC §11.1)', () => {
  const parent = buildRunConfig(BASE);

  it('accepts a complete lineage record', () => {
    valid({
      ...parent,
      runId: 'run-0002',
      parentRunId: parent.runId,
      derivedFromCheckpointHash: `sha256:${'a'.repeat(64)}`,
      babyA: { ...parent.babyA, initialPolicyRef: 'policy-a' },
      babyB: { ...parent.babyB, initialPolicyRef: 'policy-b' },
    });
  });

  it('rejects a partial lineage record', () => {
    expect(
      paths({ ...parent, runId: 'run-0002', parentRunId: parent.runId }),
    ).toContain('parentRunId');
    expect(
      paths({
        ...parent,
        runId: 'run-0002',
        parentRunId: parent.runId,
        derivedFromCheckpointHash: `sha256:${'a'.repeat(64)}`,
        babyA: { ...parent.babyA, initialPolicyRef: 'policy-a' },
      }),
    ).toContain('parentRunId');
    expect(
      paths({
        ...parent,
        babyA: { ...parent.babyA, initialPolicyRef: 'policy-a' },
        babyB: { ...parent.babyB, initialPolicyRef: 'policy-b' },
      }),
    ).toContain('parentRunId');
  });
});

describe('warnings (SPEC §10.4, §15.3)', () => {
  it('flags centralized training isolation without rejecting it', () => {
    const config = buildRunConfig({
      ...BASE,
      babyA: { trainingIsolation: 'centralized' },
      babyB: { trainingIsolation: 'centralized' },
    });
    const { warnings } = valid(config);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('babyA.trainingIsolation');
    expect(warnings[0]).toContain('centralized');
    expect(warnings[1]).toContain('babyB.trainingIsolation');
  });

  it('flags fewer than 10 evaluation seeds from E10 onward', () => {
    expect(
      valid(buildRunConfig({ ...BASE, experimentId: 'E11' })).warnings,
    ).toHaveLength(1);
    expect(
      valid(buildRunConfig({ ...BASE, experimentId: 'E11' })).warnings[0],
    ).toContain('E11');
    expect(
      valid(buildRunConfig({ ...BASE, experimentId: 'E11', evaluationSeeds: 10 }))
        .warnings,
    ).toEqual([]);
    expect(
      valid(buildRunConfig({ ...BASE, experimentId: 'E03' })).warnings,
    ).toEqual([]);
  });

  it('flags fewer than 5 evaluation seeds in any experiment', () => {
    const { warnings } = valid(
      buildRunConfig({ ...BASE, evaluationSeeds: 3 }),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('evaluationSeeds is 3');
  });
});

describe('configurationHash (HASH_DOMAINS.runConfig)', () => {
  it('matches the canonical domain hash of the validated config', () => {
    const config = buildRunConfig(BASE);
    const { configurationHash } = valid(config);
    expect(configurationHash).toBe(
      hashCanonical(HASH_DOMAINS.runConfig, config),
    );
    expect(configurationHash).toBe(hashRunConfig(config));
    expect(configurationHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('is stable across key order and repeated validation', () => {
    const config = buildRunConfig(BASE);
    const reordered = Object.fromEntries(
      Object.entries(config).reverse(),
    ) as unknown as RunConfig;
    expect(valid(reordered).configurationHash).toBe(
      valid(config).configurationHash,
    );
  });

  it('ignores fields the schema strips', () => {
    const config = buildRunConfig(BASE);
    const withExtra = { ...config, notAConfigField: 'ignored' };
    expect(valid(withExtra as RunConfig).configurationHash).toBe(
      hashRunConfig(config),
    );
  });

  it('changes when any field changes', () => {
    const config = buildRunConfig(BASE);
    const hashes = new Set([hashRunConfig(config)]);
    for (const variant of [
      { ...config, runId: 'run-0002' },
      { ...config, maxTurnsPerRun: 201 },
      { ...config, randomSeed: 'seed-0002' },
      { ...config, symbolInventorySize: 33 },
    ]) {
      hashes.add(hashRunConfig(variant));
    }
    expect(hashes.size).toBe(5);
  });

  it('is retrievable for every seed and turn budget in a property loop', () => {
    const seen = new Map<string, string>();
    for (let index = 0; index < 25; index += 1) {
      const config = buildRunConfig({
        ...BASE,
        runId: `run-${String(index).padStart(4, '0')}`,
        randomSeed: `seed-${index}`,
        maxTurnsPerRun: index + 1,
      });
      const { configurationHash } = valid(config);
      expect(seen.has(configurationHash)).toBe(false);
      seen.set(configurationHash, config.runId);
    }
    expect(seen.size).toBe(25);
  });
});

describe('RunConfigValidationError', () => {
  it('lists every failing path in its message', () => {
    let thrown: RunConfigValidationError | undefined;
    try {
      buildRunConfig({ ...BASE, experimentId: 'nope' });
    } catch (error) {
      thrown = error as RunConfigValidationError;
    }
    expect(thrown).toBeInstanceOf(RunConfigValidationError);
    expect(thrown?.message).toContain('invalid run configuration');
    expect(thrown?.message).toContain('experimentId');
    expect(thrown?.errors.length).toBeGreaterThan(0);
  });
});
