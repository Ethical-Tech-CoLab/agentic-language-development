/**
 * ALD-071 / ALD-025: the anchored-and-verified seal path, the §8.3 turn
 * deadline, and the guard rails `createRun` enforces before a run may start.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  ConsistencyProofSchema,
  GENESIS_HASH,
  InclusionProofSchema,
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
      anchorPublisher: anchorPublisherFor(runId),
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
