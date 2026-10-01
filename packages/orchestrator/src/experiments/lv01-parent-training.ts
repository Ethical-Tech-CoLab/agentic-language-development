/**
 * LV01 per-slot parent training (G2 slice).
 *
 * Collection requires a pre-sealed parent bundle per slot. This module trains
 * one: it builds a complete run config from the slot's packet-bound seeds on
 * the SPEC §18 defaults, runs training to completion on the caller's runtime,
 * and exports the sealed bundle. The caller supplies the runtime, store
 * handles, and study training parameters; nothing is invented here. Full
 * train→collect→audit composition per slot is the next slice.
 */
import { exportRunBundle, SqliteEvidenceWriter, type EvidenceDatabase } from '@ald/evidence';
import { hashCanonical } from '@ald/hashing';
import { loadLearnerContract } from '@ald/learners';
import { buildRunConfig } from '@ald/lifecycle';
import type {
  LearnerTrackId,
  RunConfig,
  SignerRegistry,
} from '@ald/types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { NurseryRuntimeImpl } from '../nursery-runtime.js';

export const LV01_PARENT_TRAINING_SEEDS_DOMAIN = 'lv01-parent-training-seeds/v1' as const;

export interface Lv01SlotParentSeeds {
  readonly scenario: string;
  readonly babyA: string;
  readonly babyB: string;
  readonly gateway: string;
  readonly analysis: string;
}

export interface Lv01SlotParentTraining {
  readonly track: LearnerTrackId;
  readonly modelRef: string;
  readonly learningSignal: RunConfig['learningSignal'];
  readonly maxTurnsPerRun: number;
  readonly evaluationTurns: number;
}

export interface Lv01TrainedParentReceipt {
  readonly runId: string;
  readonly bundleDir: string;
  readonly experimentId: string;
  readonly parentSeedsDigest: string;
  readonly completedTurns: number;
  readonly policyRefs: readonly string[];
}

function fail(message: string): never {
  throw new Error(`LV01 parent training: ${message}`);
}

export async function trainLv01SlotParent(input: {
  readonly runtime: NurseryRuntimeImpl;
  readonly database: EvidenceDatabase;
  readonly signerProvider: (runId: string) => SignerRegistry;
  readonly runId: string;
  readonly seeds: Lv01SlotParentSeeds;
  readonly training: Lv01SlotParentTraining;
  readonly ledgerValuePlan: RunConfig['ledgerValuePlan'];
  readonly runsRoot: string;
  readonly bundleDir: string;
  readonly softwareCommit: string;
  readonly deploymentMode: RunConfig['deploymentMode'];
  readonly protocolGitCommit: string;
}): Promise<{ readonly bundleDir: string; readonly receipt: Lv01TrainedParentReceipt }> {
  if (input.runId.length === 0) fail('parent run id must be non-empty');
  const config = buildRunConfig({
    deploymentMode: input.deploymentMode,
    protocolGitCommit: input.protocolGitCommit,
    runId: input.runId,
    experimentId: 'LV01',
    randomSeed: input.seeds.scenario,
    seedBindings: {
      version: 1,
      scenario: input.seeds.scenario,
      babyA: input.seeds.babyA,
      babyB: input.seeds.babyB,
      gateway: input.seeds.gateway,
      analysis: input.seeds.analysis,
    },
    babyA: { track: input.training.track, modelRef: input.training.modelRef },
    babyB: { track: input.training.track, modelRef: input.training.modelRef },
    learningSignal: input.training.learningSignal,
    maxTurnsPerRun: input.training.maxTurnsPerRun,
    ledgerValuePlan: input.ledgerValuePlan,
  });
  const parent = { ...config, evaluationTurns: input.training.evaluationTurns };
  await input.runtime.createRun(parent);
  await input.runtime.runToCompletion(parent.runId);

  const policyRefs = ['baby-a-latest.json', 'baby-b-latest.json'];
  const policyFiles: Record<string, unknown> = {};
  for (const name of policyRefs) {
    policyFiles[name] = JSON.parse(
      await readFile(join(input.runsRoot, 'runs', parent.runId, 'policies', name), 'utf8'),
    ) as unknown;
  }
  const writer = new SqliteEvidenceWriter({
    database: input.database,
    signers: input.signerProvider(parent.runId),
  });
  const contract = loadLearnerContract(input.training.track);
  await exportRunBundle(writer, parent.runId, input.bundleDir, {
    softwareCommit: input.softwareCommit,
    learnerContracts: [{ track: input.training.track, version: contract.version, text: contract.text }],
    policyFiles,
  });
  return {
    bundleDir: input.bundleDir,
    receipt: {
      runId: parent.runId,
      bundleDir: input.bundleDir,
      experimentId: parent.experimentId,
      parentSeedsDigest: hashCanonical(LV01_PARENT_TRAINING_SEEDS_DOMAIN, { ...input.seeds }),
      completedTurns: input.runtime.turnRecords(parent.runId).length,
      policyRefs,
    },
  };
}
