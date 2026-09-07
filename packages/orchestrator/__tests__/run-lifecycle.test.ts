/**
 * ALD-025 / ALD-071: a complete E03-style chance-control run, its exported
 * evidence bundle, and the SPEC §14.3 replay checks.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExperimentRecordFileSchema,
  ExperimentRecordSchema,
  RunManifestSchema,
  type ExperimentRecord,
  type TurnRecord,
} from '@ald/types';
import { parseJsonlEvents, validateChain } from '@ald/hashing';

import {
  bundleDir,
  channelChainViolations,
  createHarness,
  noLearningOverrides,
  successRate,
  testConfig,
  type Harness,
} from './helpers.js';

const RUN_ID = 'run-e03-normal';

interface CompletedRun {
  harness: Harness;
  digest: string;
}

async function runE03(seed: string): Promise<CompletedRun> {
  const harness = await createHarness();
  const config = testConfig(
    noLearningOverrides({
      runId: RUN_ID,
      experimentId: 'E03',
      randomSeed: seed,
      // `maxTurnsPerRun` must be a positive integer (SPEC §11.1), so the
      // chance control runs exactly one training turn and then evaluates.
      maxTurnsPerRun: 1,
      evaluationTurns: 40,
      communicationCondition: 'normal',
    }),
  );
  await harness.runtime.createRun(config);
  await harness.runtime.runToCompletion(RUN_ID);
  return { harness, digest: harness.runtime.replayDigest(RUN_ID) };
}

describe('E03 chance-control run (ALD-025)', () => {
  let primary: CompletedRun;
  let replica: CompletedRun;
  let otherSeed: CompletedRun;
  let records: TurnRecord[];

  beforeAll(async () => {
    primary = await runE03('ald-e03-seed-a');
    replica = await runE03('ald-e03-seed-a');
    otherSeed = await runE03('ald-e03-seed-b');
    records = primary.harness.runtime.turnRecords(RUN_ID);
  }, 120_000);

  afterAll(async () => {
    await primary.harness.cleanup();
    await replica.harness.cleanup();
    await otherSeed.harness.cleanup();
  });

  it('ends unanchored at aborted-sealed after the evaluation budget', () => {
    const summary = primary.harness.runtime.getRun(RUN_ID);
    expect(summary?.state).toBe('aborted-sealed');
    expect(summary?.turn).toBe(41);
  });

  it('writes one turn record per turn in both phases', () => {
    expect(records).toHaveLength(41);
    expect(records.filter((record) => record.phase === 'running')).toHaveLength(1);
    expect(records.filter((record) => record.phase === 'evaluating')).toHaveLength(40);
    expect(records.map((record) => record.turn)).toEqual(
      Array.from({ length: 41 }, (_, index) => index),
    );
    // §8.1 step 9: roles reverse every turn by default.
    expect(records[0]?.roles).toEqual({ sender: 'baby-a', receiver: 'baby-b' });
    expect(records[1]?.roles).toEqual({ sender: 'baby-b', receiver: 'baby-a' });
  });

  it('scores near the pre-registered chance rate', () => {
    const outcomes = records.map((record) => ({
      success: record.outcome.success === true,
    }));
    const rate = successRate(outcomes);
    expect(rate).toBeGreaterThanOrEqual(0.05);
    expect(rate).toBeLessThanOrEqual(0.5);
  });

  it('records every turn phase in the evidence chains', () => {
    const transcript = primary.harness.runtime.transcript(RUN_ID);
    expect(transcript).toHaveLength(41);
    expect(
      transcript.every((event) => event.gatewayValidationResult === 'accepted'),
    ).toBe(true);
    const ledgers = primary.harness.runtime.ledgers(RUN_ID);
    for (const ledger of [ledgers.babyA, ledgers.babyB]) {
      expect(ledger.some((event) => event.eventType === 'intention.recorded')).toBe(true);
      expect(
        ledger.some((event) => event.eventType === 'interpretation.recorded'),
      ).toBe(true);
      expect(ledger.some((event) => event.eventType === 'run.sealed')).toBe(true);
    }
  });

  it('exports a valid run manifest and the full experiment-record history', async () => {
    const directory = bundleDir(primary.harness, RUN_ID);
    const manifest = RunManifestSchema.parse(
      JSON.parse(await readFile(join(directory, 'run-manifest.json'), 'utf8')),
    );
    expect(manifest.runId).toBe(RUN_ID);
    expect(manifest.deploymentMode).toBe('prototype');
    expect(manifest.softwareCommit).toBe('git:orchestrator-test');

    const file = ExperimentRecordFileSchema.parse(
      JSON.parse(await readFile(join(directory, 'experiment-record.json'), 'utf8')),
    );
    const history = file.history.map((entry) =>
      ExperimentRecordSchema.parse(entry),
    );
    expect(history.map((entry) => entry.recordVersion)).toEqual([1, 2, 3]);
    const current: ExperimentRecord = ExperimentRecordSchema.parse(file.current);
    expect(current.recordVersion).toBe(3);
    // Unanchored: §7.2 keeps the disposition `invalid` permanently.
    expect(current.disposition).toBe('invalid');
    expect(current.anchorTxRef).toBe(`0x${'0'.repeat(64)}`);
    expect(current.deviations.join(' ')).toContain(
      'anchoring-skipped-prototype-mode',
    );
    expect(current.checkpointManifestRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('reproduces the replay digest from the seed and separates seeds', () => {
    expect(primary.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(replica.digest).toBe(primary.digest);
    expect(otherSeed.digest).not.toBe(primary.digest);
  });

  it('passes scenario replay from the recorded configuration', () => {
    const result = primary.harness.runtime.scenarioReplayCheck(RUN_ID);
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.turnsChecked).toBe(41);
  });

  it('exports chains that validate under the run signer keys', async () => {
    const directory = bundleDir(primary.harness, RUN_ID);
    const manifest = RunManifestSchema.parse(
      JSON.parse(await readFile(join(directory, 'run-manifest.json'), 'utf8')),
    );

    for (const declaration of manifest.streams) {
      if (
        declaration.stream !== 'baby-a-ledger' &&
        declaration.stream !== 'baby-b-ledger' &&
        declaration.stream !== 'channel'
      ) {
        continue;
      }
      const events = parseJsonlEvents(
        await readFile(join(directory, declaration.file), 'utf8'),
        { requireCanonical: true },
      );
      expect(events.length).toBeGreaterThan(0);
      const signer = manifest.signers.find(
        (candidate) => candidate.domain === declaration.signerDomain,
      );
      expect(signer).toBeDefined();

      if (declaration.stream === 'channel') {
        expect(
          channelChainViolations(events, {
            runId: RUN_ID,
            publicKey: signer?.publicKey ?? '',
          }),
        ).toEqual([]);
        continue;
      }

      const result = validateChain(declaration.stream, events, {
        runId: RUN_ID,
        publicKey: signer?.publicKey,
        requireSignatures: true,
        babyId: declaration.stream === 'baby-a-ledger' ? 'A' : 'B',
      });
      expect(result.violations).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('chains every checkpoint manifest from the genesis hash', () => {
    const checkpoints = primary.harness.runtime.checkpoints(RUN_ID);
    expect(checkpoints.length).toBeGreaterThanOrEqual(2);
    expect(checkpoints[0]?.checkpointSequence).toBe(0);
    expect(checkpoints[0]?.reason).toBe('run-initialized');
    expect(checkpoints.at(-1)?.reason).toBe('run-sealed');
    checkpoints.forEach((manifest, index) => {
      expect(manifest.checkpointSequence).toBe(index);
      const previous = index === 0 ? `sha256:${'0'.repeat(64)}` : checkpoints[index - 1]?.checkpointHash;
      expect(manifest.previousCheckpointHash).toBe(previous);
    });
  });
});
