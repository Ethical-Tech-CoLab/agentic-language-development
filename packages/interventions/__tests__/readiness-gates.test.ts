/** Cross-capability readiness checks for ALD-075 E21 and ALD-077 E50. */
import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@ald/hashing';
import { createDerivedRunConfig } from '@ald/lifecycle';
import { buildConformanceRunConfig } from '@ald/learners';
import { HASH_DOMAINS } from '@ald/types';

import { aggregateAcrossSeeds } from '../src/index.js';

describe('experiment readiness gates', () => {
  it('runs every E21 learner condition against the identical scenario configuration', () => {
    const seed = 'e21-shared-scenario';
    const options = { seed, experimentId: 'E21', episodes: 24 } as const;
    const configs = [
      buildConformanceRunConfig('no-learning', options),
      buildConformanceRunConfig('frozen-llm', options),
      buildConformanceRunConfig('scratch-rl', {
        ...options,
        learningSignal: 'extrinsic-task',
      }),
      buildConformanceRunConfig('scratch-rl', {
        ...options,
        learningSignal: 'intrinsic-curiosity',
      }),
      buildConformanceRunConfig('self-supervised', {
        ...options,
        learningSignal: 'self-supervised',
      }),
    ];

    expect(new Set(configs.map((config) => config.scenarioBundleHash))).toEqual(
      new Set([configs[0]?.scenarioBundleHash]),
    );
    expect(new Set(configs.map((config) => config.randomSeed))).toEqual(
      new Set([seed]),
    );
    expect(new Set(configs.map((config) => config.experimentId))).toEqual(
      new Set(['E21']),
    );
  });

  it('creates E50 independent-seed children from one pre-registered parent and aggregates every seed', () => {
    const parent = buildConformanceRunConfig('no-learning', {
      runId: 'e50-parent',
      experimentId: 'E50',
      seed: 'e50-parent-seed',
    });
    const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, {
      runId: parent.runId,
      checkpoint: 1,
    });
    const seeds = Array.from({ length: 10 }, (_, index) => `e50-seed-${index}`);
    const children = seeds.map((randomSeed, index) =>
      createDerivedRunConfig(parent, checkpointHash, `e50-child-${index}`, {
        babyAInitialPolicyRef: 'policies/baby-a-policy-initial.json',
        babyBInitialPolicyRef: 'policies/baby-b-policy-initial.json',
        overrides: { randomSeed },
      }),
    );

    expect(new Set(children.map((child) => child.parentRunId))).toEqual(
      new Set([parent.runId]),
    );
    expect(new Set(children.map((child) => child.preRegistrationHash))).toEqual(
      new Set([parent.preRegistrationHash]),
    );
    expect(new Set(children.map((child) => child.randomSeed)).size).toBe(10);

    const result = aggregateAcrossSeeds({
      seed: 'e50-aggregate',
      findings: [
        {
          findingId: 'primary-success',
          metricLabel: 'success proportion',
          original: {
            label: 'original',
            perSeedValues: [0.7, 0.72, 0.71, 0.73, 0.69, 0.74, 0.7, 0.72, 0.71, 0.73],
          },
          replication: {
            label: 'replication',
            perSeedValues: [0.68, 0.7, 0.71, 0.69, 0.72, 0.7, 0.73, 0.71, 0.69, 0.72],
          },
          nullValue: 0.25,
          rule: { type: 'ci-excludes-null' },
          expectedDirection: 'greater',
        },
      ],
      bootstrapIterations: 200,
    });

    expect(result.findings[0]?.original.seeds).toBe(children.length);
    expect(result.findings[0]?.replication.seeds).toBe(children.length);
    expect(result.summary).toMatchObject({ findings: 1, replicated: 1 });
    expect(result.negativeResultsIncluded).toBe(true);
    expect(result.claimBoundary).toBe('software-readiness-only');
  });
});
