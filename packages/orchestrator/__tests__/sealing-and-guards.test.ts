/**
 * ALD-071 / ALD-025: the anchored-and-verified seal path, the §8.3 turn
 * deadline, and the guard rails `createRun` enforces before a run may start.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createLearnerAdapterFactory } from '@ald/learners';
import {
  MODE_COMPARISON,
  ConsistencyProofSchema,
  GENESIS_HASH,
  InclusionProofSchema,
  type BabyRole,
  type IsolationDescriptor,
  type LearnerAdapterFactory,
} from '@ald/types';
import { verifyConsistency, verifyInclusion } from '@ald/merkle';

import {
  SOFTWARE_COMMIT,
  anchorPublisherFor,
  bundleDir,
  createHarness,
  createSimpleProofWriterFor,
  fakeVerifier,
  noLearningOverrides,
  slowFactory,
  testConfig,
  type Harness,
} from './helpers.js';

function declaredIsolationFactory(
  role: BabyRole,
  descriptor: IsolationDescriptor,
): LearnerAdapterFactory {
  const inner = createLearnerAdapterFactory('no-learning', {
    seed: `mode-guard-${role}`,
  });
  return {
    track: 'no-learning',
    isolation: descriptor.boundary,
    create: () => Object.assign(inner.create(), { isolation: descriptor }),
  };
}

describe('anchored seal path (ALD-071)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('marks the run valid only after an anchor and a passing verifier', async () => {
    const runId = 'run-anchored';
    const proofWriter = createSimpleProofWriterFor(() => harness);
    harness = await createHarness({
      anchorPolicy: 'required',
      // The publisher owns the receipt row, exactly as `BaseAnchorPublisher`
      // does; the runtime never writes one.
      anchorPublisher: anchorPublisherFor(runId, false, {
        evidence: () => harness?.runtime.writerFor(runId),
      }),
      verifier: fakeVerifier(runId),
      proofWriter,
    });
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-anchored',
        maxTurnsPerRun: 1,
        evaluationTurns: 4,
      }),
    );
    await harness.runtime.createRun(config);
    const summary = await harness.runtime.runToCompletion(runId);

    expect(summary.state).toBe('sealed');
    const records = harness.runtime.experimentRecords(runId);
    expect(records.map((record) => record.recordVersion)).toEqual([1, 2, 3]);
    const current = records.at(-1);
    expect(current?.disposition).toBe('valid');
    expect(current?.verifierReportRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(current?.anchorTxRef).not.toBe(`0x${'0'.repeat(64)}`);
    expect(current?.deviations).toEqual([]);

    const receipts = harness.runtime.writerFor(runId).readAnchorReceipts(runId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('confirmed');
    expect(receipts[0]?.checkpointHash).toBe(current?.checkpointManifestRef);
    // LEDGER §12: only the checkpoint digest is anchored.
    expect(receipts[0]?.inputData).toBe(
      `0x${(current?.checkpointManifestRef ?? '').slice('sha256:'.length)}`,
    );

    const anchorsFile = JSON.parse(
      await readFile(
        join(bundleDir(harness, runId), 'anchors', 'base-receipts.json'),
        'utf8',
      ),
    ) as unknown[];
    expect(anchorsFile).toHaveLength(1);
  }, 60_000);

  it('writes inclusion and consistency proofs that verify against the final root', async () => {
    const runId = 'run-proofs';
    const proofWriter = createSimpleProofWriterFor(() => harness);
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      verifier: fakeVerifier(runId),
      proofWriter,
    });
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-proofs',
        maxTurnsPerRun: 1,
        evaluationTurns: 4,
      }),
    );
    await harness.runtime.createRun(config);
    await harness.runtime.runToCompletion(runId);

    const checkpoints = harness.runtime.checkpoints(runId);
    const last = checkpoints.at(-1);
    expect(last).toBeDefined();
    const directory = join(bundleDir(harness, runId), 'proofs');

    const inclusion = InclusionProofSchema.parse(
      JSON.parse(
        await readFile(
          join(
            directory,
            'inclusion',
            `channel-${String(last?.channel.treeSize)}-at-${String(last?.checkpointSequence)}.json`,
          ),
          'utf8',
        ),
      ),
    );
    expect(inclusion.root).toBe(last?.channel.merkleRoot);
    expect(verifyInclusion(inclusion)).toBe(true);

    const consistency = ConsistencyProofSchema.parse(
      JSON.parse(
        await readFile(
          join(
            directory,
            'consistency',
            `channel-0-${String(last?.checkpointSequence)}.json`,
          ),
          'utf8',
        ),
      ),
    );
    expect(consistency.toRoot).toBe(last?.channel.merkleRoot);
    expect(verifyConsistency(consistency)).toBe(true);
  }, 60_000);

  it('blocks sealing when the publisher cannot anchor', async () => {
    const runId = 'run-anchor-down';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId, true),
    });
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-anchor-down',
        maxTurnsPerRun: 1,
        evaluationTurns: 2,
      }),
    );
    await harness.runtime.createRun(config);
    const summary = await harness.runtime.runToCompletion(runId);

    // §7.2: export or anchor unavailable after bounded retry.
    expect(summary.state).toBe('sealing-blocked');
    const current = harness.runtime.experimentRecords(runId).at(-1);
    expect(current?.disposition).toBe('invalid');
    expect(current?.deviations.join(' ')).toContain('anchor-unavailable');
    // The unanchored tail is still exported.
    const manifest = JSON.parse(
      await readFile(join(bundleDir(harness, runId), 'run-manifest.json'), 'utf8'),
    ) as { softwareCommit: string };
    expect(manifest.softwareCommit).toBe(SOFTWARE_COMMIT);
  }, 60_000);
});

describe('turn budget (SPEC §8.3)', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('forfeits a turn whose sender misses the response deadline', async () => {
    harness = await createHarness({
      adapterFactoryFor: () => slowFactory(2_000),
    });
    const runId = 'run-timeout';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-timeout',
        maxTurnsPerRun: 4,
        evaluationTurns: 2,
        turnResponseBudgetMs: 1_000,
      }),
    );
    await harness.runtime.createRun(config);
    const result = await harness.runtime.step(runId);

    expect(result.channelEvent?.gatewayValidationResult).toBe('rejected');
    expect(result.channelEvent?.reasonCode).toBe('timeout');
    expect(result.outcome.success).toBe(false);
    expect(result.outcome.details).toMatchObject({ reasonCode: 'timeout' });
    // A null action is recorded, not a retry (§8.3, §10.3).
    expect(result.turnRecord.babyProposalHash).toBeNull();
    expect(result.turnRecord.channelEventHash).toBe(
      result.channelEvent?.entryHash,
    );
    expect(result.state).toBe('running');
  }, 60_000);
});

describe('run creation guard rails', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it('fills in placeholder bundle hashes and rejects a mismatch', async () => {
    harness = await createHarness();
    const runId = 'run-hashes';
    const config = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-hashes',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
      }),
    );
    expect(config.scenarioBundleHash).toBe(GENESIS_HASH);
    await harness.runtime.createRun(config);

    const stored = harness.runtime.writerFor(runId).readRunMetadata(runId);
    const registered = JSON.parse(stored?.configurationJson ?? '{}') as {
      scenarioBundleHash: string;
      promptBundleHash: string;
    };
    expect(registered.scenarioBundleHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(registered.scenarioBundleHash).not.toBe(GENESIS_HASH);
    expect(registered.promptBundleHash).not.toBe(GENESIS_HASH);

    await expect(
      harness.runtime.createRun({
        ...config,
        runId: 'run-hash-mismatch',
        scenarioBundleHash: `sha256:${'a'.repeat(64)}`,
      }),
    ).rejects.toThrow(/scenarioBundleHash/u);
  }, 60_000);

  it('refuses the shuffled condition for a learning track', async () => {
    harness = await createHarness();
    await expect(
      harness.runtime.createRun(
        testConfig({
          runId: 'run-shuffled-rl',
          experimentId: 'E03',
          randomSeed: 'ald-shuffled-rl',
          babyA: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
          babyB: { track: 'scratch-rl', modelRef: 'tabular-reinforce-v1' },
          learningSignal: 'extrinsic-task',
          communicationCondition: 'shuffled',
          maxTurnsPerRun: 2,
          evaluationTurns: 2,
        }),
      ),
    ).rejects.toThrow(/no-learning/u);
  });

  it('refuses to skip anchoring outside prototype mode', async () => {
    harness = await createHarness({ anchorPolicy: 'skip' });
    await expect(
      harness.runtime.createRun(
        testConfig(
          noLearningOverrides({
            runId: 'run-research-grade',
            experimentId: 'E03',
            randomSeed: 'ald-research-grade',
            deploymentMode: 'research-grade',
            maxTurnsPerRun: 1,
            evaluationTurns: 1,
          }),
        ),
      ),
    ).rejects.toThrow(/prototype mode/u);
  });

  it('refuses a publisher whose simulated/public class differs from RunConfig', async () => {
    const runId = 'run-anchor-class-mismatch';
    const simulated = anchorPublisherFor(runId);
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: { ...simulated, anchorClass: 'public-chain' },
    });
    await expect(
      harness.runtime.createRun(
        testConfig(
          noLearningOverrides({
            runId,
            experimentId: 'E03',
            randomSeed: 'ald-anchor-class-mismatch',
            maxTurnsPerRun: 1,
            evaluationTurns: 1,
          }),
        ),
      ),
    ).rejects.toThrow(/does not match RunConfig\.anchorClass simulated/u);
  });

  it('refuses an external learner boundary under Prototype Mode', async () => {
    harness = await createHarness({
      adapterFactoryFor: (_config, role) =>
        declaredIsolationFactory(role, {
          boundary: 'separate-process',
          timingNormalization: 'immediate',
          processId: role === 'baby-a' ? 101 : 102,
        }),
    });
    await expect(
      harness.runtime.createRun(
        testConfig(
          noLearningOverrides({
            runId: 'run-prototype-external',
            experimentId: 'E03',
            randomSeed: 'ald-prototype-external',
            maxTurnsPerRun: 1,
            evaluationTurns: 1,
          }),
        ),
      ),
    ).rejects.toThrow(/prototype mode requires in-process/u);
  });

  it('refuses a Research-Grade label without normalized distinct containers', async () => {
    const runId = 'run-research-grade-process';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      adapterFactoryFor: (_config, role) =>
        declaredIsolationFactory(role, {
          boundary: 'separate-process',
          timingNormalization: 'immediate',
          processId: role === 'baby-a' ? 201 : 202,
        }),
    });
    await expect(
      harness.runtime.createRun({
        ...testConfig(
          noLearningOverrides({
            runId,
            experimentId: 'E03',
            randomSeed: 'ald-research-grade-process',
            maxTurnsPerRun: 1,
            evaluationTurns: 1,
          }),
        ),
        deploymentMode: 'research-grade',
      }),
    ).rejects.toThrow(/separate-container/u);
  });

  it('accepts a Research-Grade label only for normalized distinct containers', async () => {
    const runId = 'run-research-grade-containers';
    harness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      adapterFactoryFor: (_config, role) =>
        declaredIsolationFactory(role, {
          boundary: 'separate-container',
          timingNormalization: 'normalized',
          processId: 1,
          containerId: role === 'baby-a' ? 'container-a' : 'container-b',
        }),
    });
    const config = {
      ...testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-research-grade-containers',
          maxTurnsPerRun: 1,
          evaluationTurns: 1,
        }),
      ),
      deploymentMode: 'research-grade',
    } as const;
    const summary = await harness.runtime.createRun(config);
    expect(summary.state).toBe('running');

    // The caller cannot switch the live run by mutating its input object.
    (config as { deploymentMode: 'prototype' | 'research-grade' }).deploymentMode =
      'prototype';
    const stored = harness.runtime.writerFor(runId).readRunMetadata(runId);
    expect(JSON.parse(stored?.configurationJson ?? '{}')).toMatchObject({
      deploymentMode: 'research-grade',
    });
  });

  it('changes only the six documented §5.3 deployment dimensions between Mode P and Mode R', async () => {
    const runId = 'run-mode-comparison';
    harness = await createHarness();
    const prototypeConfig = testConfig(
      noLearningOverrides({
        runId,
        experimentId: 'E03',
        randomSeed: 'ald-mode-comparison',
        maxTurnsPerRun: 1,
        evaluationTurns: 1,
      }),
    );
    const prototypeSummary = await harness.runtime.createRun(prototypeConfig);

    const researchHarness = await createHarness({
      anchorPolicy: 'required',
      anchorPublisher: anchorPublisherFor(runId),
      adapterFactoryFor: (_config, role) =>
        declaredIsolationFactory(role, {
          boundary: 'separate-container',
          timingNormalization: 'normalized',
          processId: role === 'baby-a' ? 301 : 302,
          containerId: role === 'baby-a' ? 'mode-r-a' : 'mode-r-b',
        }),
    });
    try {
      const researchConfig = {
        ...prototypeConfig,
        deploymentMode: 'research-grade',
      } as const;
      const researchSummary = await researchHarness.runtime.createRun(researchConfig);

      expect(
        Object.keys(prototypeSummary)
          .filter(
            (key) =>
              JSON.stringify(prototypeSummary[key as keyof typeof prototypeSummary]) !==
              JSON.stringify(researchSummary[key as keyof typeof researchSummary]),
          )
          .sort(),
      ).toEqual(['configurationHash', 'deploymentMode']);
      expect(
        Object.keys(MODE_COMPARISON),
      ).toEqual([
        'processBoundaryBetweenBabies',
        'networkRouteBetweenBabies',
        'ledgerWriterKeyIsolation',
        'turnTimingNormalization',
        'suitableFor',
        'requiredBeforePublicBaseMainnetRuns',
      ]);
      for (const dimension of Object.values(MODE_COMPARISON)) {
        expect(dimension.prototype).not.toEqual(dimension['research-grade']);
      }

      const configKeys = new Set([
        ...Object.keys(prototypeConfig),
        ...Object.keys(researchConfig),
      ]);
      expect(
        [...configKeys].filter(
          (key) =>
            JSON.stringify(prototypeConfig[key as keyof typeof prototypeConfig]) !==
            JSON.stringify(researchConfig[key as keyof typeof researchConfig]),
        ),
      ).toEqual(['deploymentMode']);
    } finally {
      await researchHarness.cleanup();
    }
  });

  it('refuses an anchoring run without a publisher', async () => {
    harness = await createHarness({ anchorPolicy: 'required' });
    await expect(
      harness.runtime.createRun(
        testConfig(
          noLearningOverrides({
            runId: 'run-no-publisher',
            experimentId: 'E03',
            randomSeed: 'ald-no-publisher',
            maxTurnsPerRun: 1,
            evaluationTurns: 1,
          }),
        ),
      ),
    ).rejects.toThrow(/anchorPublisher/u);
  });

  it('requires an injected verifier for verify()', async () => {
    harness = await createHarness();
    const runId = 'run-no-verifier';
    await harness.runtime.createRun(
      testConfig(
        noLearningOverrides({
          runId,
          experimentId: 'E03',
          randomSeed: 'ald-no-verifier',
          maxTurnsPerRun: 1,
          evaluationTurns: 1,
        }),
      ),
    );
    await expect(
      harness.runtime.verify(runId, bundleDir(harness, runId)),
    ).rejects.toThrow(/verifier/u);
    expect(harness.runtime.getRun('nope')).toBeUndefined();
    expect(harness.runtime.listRuns().map((run) => run.runId)).toEqual([runId]);
  });
});
