/** Privacy-minimized real-model qualification report for the frozen-LLM path. */
import { hashCanonical } from '@ald/hashing';
import { HASH_DOMAINS, type BabyRole } from '@ald/types';

import { runLearnerAdapterConformance } from './conformance.js';
import { createFrozenLlmAdapterFactory } from './frozen-llm.js';
import {
  formatModelRef,
  type LocalModelClient,
  type LocalModelDescription,
} from './llm-client.js';

export const FROZEN_MODEL_QUALIFICATION_VERSION = 1;
export const FROZEN_MODEL_QUALIFICATION_LABEL =
  'Non-confirmatory frozen-model software qualification: this exercises the ' +
  'learner contract and tool boundary only; it is not pre-registered, not ' +
  'anchored, and is not a research finding about model behavior.';

export interface FrozenModelRuntimeDescription {
  readonly id: string;
  readonly artifactHash: `sha256:${string}`;
}

export interface FrozenModelQualificationOptions {
  readonly client: LocalModelClient;
  readonly softwareCommit: string;
  readonly executedAt: string;
  readonly runtime: FrozenModelRuntimeDescription;
  readonly episodes?: number;
  readonly seed?: string;
  readonly symbolInventorySize?: number;
  readonly messageLength?: number;
}

export interface FrozenModelRoleQualification {
  readonly intentions: number;
  readonly interpretations: number;
  readonly firstEmissions: number;
  readonly firstReceipts: number;
  readonly hypotheses: number;
  readonly finalPolicyHash: string;
}

export interface FrozenModelQualificationReport {
  readonly version: typeof FROZEN_MODEL_QUALIFICATION_VERSION;
  readonly claimBoundary: typeof FROZEN_MODEL_QUALIFICATION_LABEL;
  readonly softwareCommit: string;
  readonly executedAt: string;
  readonly runtime: FrozenModelRuntimeDescription;
  readonly model: LocalModelDescription;
  readonly seedHash: string;
  readonly episodes: number;
  readonly proposals: number;
  readonly successes: number;
  readonly descriptiveSuccessRate: number;
  readonly roles: Record<BabyRole, FrozenModelRoleQualification>;
  readonly toolOnlyConformance: true;
  readonly policyUpdatesObserved: false;
}

export async function runFrozenModelQualification(
  options: FrozenModelQualificationOptions,
): Promise<FrozenModelQualificationReport> {
  const episodes = options.episodes ?? 2;
  if (!Number.isInteger(episodes) || episodes < 2) {
    throw new Error('frozen-model qualification requires at least two episodes');
  }
  if (
    options.runtime.id.trim() === '' ||
    !/^sha256:[0-9a-f]{64}$/u.test(options.runtime.artifactHash)
  ) {
    throw new Error('frozen-model qualification requires exact runtime provenance');
  }
  const seed = options.seed ?? 'ald-real-frozen-model-qualification-v1';
  const model = options.client.describe();
  const factory = createFrozenLlmAdapterFactory({
    client: options.client,
    maxOutputTokens: 192,
    temperature: 0,
    modelBudgetFraction: 0.95,
  });
  const result = await runLearnerAdapterConformance(factory, {
    deploymentMode: 'prototype',
    experimentId: 'E10',
    runId: 'frozen-model-qualification',
    modelRef: formatModelRef(model.modelId, model.weightsHash),
    turnResponseBudgetMs: 120_000,
    episodes,
    seed,
    roleReversalPeriod: 1,
    symbolInventorySize: options.symbolInventorySize ?? 32,
    messageLength: options.messageLength ?? 1,
    updatePolicy: false,
  });
  const roleReport = (role: BabyRole): FrozenModelRoleQualification => {
    const ledger = result.ledgers[role];
    const hashes = result.policyHashes[role];
    return {
      intentions: ledger.countOf('intention.recorded'),
      interpretations: ledger.countOf('interpretation.recorded'),
      firstEmissions: ledger.countOf('term.first_emitted'),
      firstReceipts: ledger.countOf('term.first_received'),
      hypotheses:
        ledger.countOf('hypothesis.created') +
        ledger.countOf('hypothesis.revised'),
      finalPolicyHash: hashes.at(-1) ?? hashCanonical(HASH_DOMAINS.policyCheckpoint, {}),
    };
  };

  return {
    version: FROZEN_MODEL_QUALIFICATION_VERSION,
    claimBoundary: FROZEN_MODEL_QUALIFICATION_LABEL,
    softwareCommit: options.softwareCommit,
    executedAt: options.executedAt,
    runtime: options.runtime,
    model,
    seedHash: hashCanonical(HASH_DOMAINS.seed, seed),
    episodes: result.episodes,
    proposals: result.proposals,
    successes: result.successes,
    descriptiveSuccessRate: result.successRate,
    roles: {
      'baby-a': roleReport('baby-a'),
      'baby-b': roleReport('baby-b'),
    },
    toolOnlyConformance: true,
    policyUpdatesObserved: false,
  };
}
