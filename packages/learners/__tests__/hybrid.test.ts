import { describe, expect, it } from 'vitest';
import { HASH_DOMAINS, fixedTokenInventory } from '@ald/types';
import { domainHash } from '@ald/hashing';

import {
  RecordingLedgerClient,
  buildConformanceRunConfig,
  runLearnerAdapterConformance,
} from '../src/conformance.js';
import { loadLearnerContract } from '../src/contracts.js';
import {
  ExportedHybridPolicySchema,
  HybridAdapter,
  createHybridAdapterFactory,
} from '../src/hybrid.js';

function standInContract() {
  return { ...loadLearnerContract('scratch-rl'), track: 'hybrid' as const };
}

describe('HybridAdapter', () => {
  it('completes full turns and updates every private component', async () => {
    const result = await runLearnerAdapterConformance(
      createHybridAdapterFactory({ codeBits: 3 }),
      {
        episodes: 10,
        seed: 'hybrid-conformance',
        learningSignal: 'extrinsic-task',
        learnerContract: standInContract(),
      },
    );

    expect(result.proposals).toBe(20);
    for (const role of ['baby-a', 'baby-b'] as const) {
      expect(result.checkpoints[role]).toHaveLength(10);
      expect(new Set(result.policyHashes[role]).size).toBeGreaterThan(1);

      const adapter = result.adapters[role] as HybridAdapter;
      const policy = ExportedHybridPolicySchema.parse(adapter.exportPolicy());
      expect(policy.components.map((component) => component.kind)).toEqual([
        'sensory-encoder',
        'world-model',
        'world-model',
        'communication-policy',
      ]);
      expect(policy.components.every((component) => component.hash.startsWith('sha256:'))).toBe(
        true,
      );
      expect(policy.world.message.pairs).toBeGreaterThan(0);
      expect(adapter.describeProvenance()).toMatchObject({
        track: 'hybrid',
        textTokenizerPresent: false,
        textAlignedEncoderPresent: false,
        weightUpdatePath: 'private-buffers-only',
      });
    }
  });

  it('reproduces the same initialized component hashes for the same private seed', async () => {
    const initialize = async (): Promise<HybridAdapter> => {
      const adapter = new HybridAdapter({ codeBits: 3 });
      const config = buildConformanceRunConfig('hybrid', {
        episodes: 2,
        learningSignal: 'extrinsic-task',
      });
      await adapter.init({
        runId: config.runId,
        role: 'baby-a',
        babyId: 'A',
        config,
        learnerContract: standInContract(),
        seed: 'hybrid-initialization',
        symbolInventory: fixedTokenInventory(8),
        ledger: new RecordingLedgerClient(config.runId, 'baby-a'),
      });
      return adapter;
    };

    const first = await initialize();
    const second = await initialize();

    expect(second.initialPolicyHash()).toBe(first.initialPolicyHash());
    expect(second.componentRecords()).toEqual(first.componentRecords());
  });

  it('automatically weakens classification for a text-aligned frozen feature path', async () => {
    const adapter = new HybridAdapter({
      codeBits: 3,
      frozenVisualFeatures: {
        name: 'fixture-text-aligned-encoder',
        hash: domainHash(HASH_DOMAINS.policyCheckpoint, 'fixture-weights'),
        textAligned: true,
        dimension: 2,
        outputScale: 4,
        project: (row) => [row[0] ?? 0, row[1] ?? 0],
      },
    });
    const config = buildConformanceRunConfig('hybrid', {
      episodes: 2,
      learningSignal: 'extrinsic-task',
    });
    await adapter.init({
      runId: config.runId,
      role: 'baby-a',
      babyId: 'A',
      config,
      learnerContract: standInContract(),
      seed: 'hybrid-text-aligned',
      symbolInventory: fixedTokenInventory(8),
      ledger: new RecordingLedgerClient(config.runId, 'baby-a'),
    });

    expect(adapter.claimClassification()).toBe('weakened-text-aligned-features');
    expect(adapter.describeProvenance()).toMatchObject({
      textAlignedEncoderPresent: true,
    });
    expect(adapter.componentRecords().at(-1)).toMatchObject({
      name: 'fixture-text-aligned-encoder',
      provenance: 'frozen-visual-features',
      textAligned: true,
    });
  });
});
