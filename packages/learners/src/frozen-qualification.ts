/** Privacy-minimized real-model qualification report for the frozen-LLM path. */
import { hashCanonical } from '@ald/hashing';
import {
  HASH_DOMAINS,
  type BabyRole,
  type LearnerAdapterFactory,
} from '@ald/types';

import { runLearnerAdapterConformance } from './conformance.js';
import { FrozenLlmAdapter } from './frozen-llm.js';
import {
  formatModelRef,
  type LocalModelClient,
  type LocalModelDescription,
} from './llm-client.js';
import type { LlamaServerAttestation } from './llama-server-probe.js';

export const FROZEN_MODEL_QUALIFICATION_VERSION = 2;
export const FROZEN_MODEL_QUALIFICATION_LABEL =
  'Non-confirmatory frozen-model software qualification: this exercises the ' +
  'learner contract and tool boundary only; it is not pre-registered, not ' +
  'anchored, and is not a research finding about model behavior.';

export interface FrozenModelRuntimeDescription {
  readonly id: string;
  readonly artifactHash: `sha256:${string}`;
  readonly installationManager: 'homebrew';
  readonly formula: 'llama.cpp';
  readonly formulaVersion: string;
  readonly bottleSha256: `sha256:${string}`;
}

export interface FrozenModelLaunchConfiguration {
  readonly host: '127.0.0.1';
  readonly contextLength: number;
  readonly parallelSlots: 1;
  readonly promptCacheEnabled: false;
  readonly temperature: 0;
  readonly maxOutputTokens: number;
  readonly turnResponseBudgetMs: number;
  readonly thinkingDisabled: true;
  readonly toolChoice: 'required';
}

export interface FrozenModelResetEvidence {
  readonly strategy: 'clean-process-restart';
  readonly roles: Record<
    BabyRole,
    {
      readonly beforeResponseHash: `sha256:${string}`;
      readonly afterResponseHash: `sha256:${string}`;
      readonly matched: true;
    }
  >;
}

export interface FrozenModelQualificationOptions {
  readonly clients: Record<BabyRole, LocalModelClient>;
  readonly softwareCommit: string;
  readonly executedAt: string;
  readonly runtime: FrozenModelRuntimeDescription;
  readonly launch: FrozenModelLaunchConfiguration;
  readonly servers: Record<BabyRole, LlamaServerAttestation>;
  readonly reset: FrozenModelResetEvidence;
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
  readonly modelCalls: number;
  readonly policyHashes: string[];
  readonly privateMemoryChanged: boolean;
  readonly finalPolicyHash: string;
}

export interface FrozenModelQualificationReport {
  readonly version: typeof FROZEN_MODEL_QUALIFICATION_VERSION;
  readonly claimBoundary: typeof FROZEN_MODEL_QUALIFICATION_LABEL;
  readonly softwareCommit: string;
  readonly executedAt: string;
  readonly runtime: FrozenModelRuntimeDescription;
  readonly model: LocalModelDescription;
  readonly launch: FrozenModelLaunchConfiguration;
  readonly servers: Record<BabyRole, LlamaServerAttestation>;
  readonly reset: FrozenModelResetEvidence;
  readonly isolation: {
    readonly topology: 'dedicated-process-per-role-serialized';
    readonly distinctClientInstances: true;
    readonly distinctLoopbackEndpoints: true;
    readonly oneSlotPerRole: true;
    readonly promptCacheEnabled: false;
    readonly roleProcessesOverlap: false;
  };
  readonly seedHash: string;
  readonly episodes: number;
  readonly proposals: number;
  readonly successes: number;
  readonly descriptiveSuccessRate: number;
  readonly roles: Record<BabyRole, FrozenModelRoleQualification>;
  readonly toolBoundary: {
    readonly requiredToolChoice: true;
    readonly liveCalls: number;
    readonly conformingCalls: number;
    readonly violations: 0;
  };
  readonly freezeSemantics: {
    readonly weightUpdatePath: 'none';
    readonly updatePolicyExposed: false;
    readonly clientDescriptionsStable: true;
    readonly exactWeightHashSharedByRoles: true;
    readonly privateMemoryExpectedToChange: true;
  };
}

function assertExactHash(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} requires an exact SHA-256 digest`);
  }
}

function assertAttestedExecution(options: FrozenModelQualificationOptions): void {
  if (
    options.runtime.id.trim() === '' ||
    options.runtime.formulaVersion.trim() === ''
  ) {
    throw new Error('frozen-model qualification requires exact runtime provenance');
  }
  assertExactHash(options.runtime.artifactHash, 'runtime artifact');
  assertExactHash(options.runtime.bottleSha256, 'Homebrew bottle');
  if (
    options.launch.contextLength <= 0 ||
    options.launch.maxOutputTokens <= 0 ||
    options.launch.turnResponseBudgetMs <= 0 ||
    options.launch.contextLength !==
      options.servers['baby-a'].configuredContextLength ||
    options.launch.contextLength !==
      options.servers['baby-b'].configuredContextLength
  ) {
    throw new Error('launch configuration does not match live server context');
  }
  const endpoints = new Set(
    Object.values(options.servers).map((server) => server.endpoint),
  );
  if (
    options.clients['baby-a'] === options.clients['baby-b'] ||
    endpoints.size !== 2 ||
    Object.values(options.servers).some(
      (server) =>
        server.health !== 'ok' ||
        server.totalSlots !== 1 ||
        server.slotContextLengths.length !== 1 ||
        !server.supportsTools,
    )
  ) {
    throw new Error('qualification requires isolated, tool-capable role servers');
  }
  for (const role of ['baby-a', 'baby-b'] as const) {
    const replay = options.reset.roles[role];
    assertExactHash(replay.beforeResponseHash, `${role} pre-reset response`);
    assertExactHash(replay.afterResponseHash, `${role} post-reset response`);
    if (replay.beforeResponseHash !== replay.afterResponseHash) {
      throw new Error(`${role} clean-process reset replay did not match`);
    }
  }
}

function descriptionsEqual(
  left: LocalModelDescription,
  right: LocalModelDescription,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runFrozenModelQualification(
  options: FrozenModelQualificationOptions,
): Promise<FrozenModelQualificationReport> {
  const episodes = options.episodes ?? 2;
  if (!Number.isInteger(episodes) || episodes < 2) {
    throw new Error('frozen-model qualification requires at least two episodes');
  }
  assertAttestedExecution(options);

  const beforeDescriptions = {
    'baby-a': options.clients['baby-a'].describe(),
    'baby-b': options.clients['baby-b'].describe(),
  } as const;
  if (
    !descriptionsEqual(
      beforeDescriptions['baby-a'],
      beforeDescriptions['baby-b'],
    )
  ) {
    throw new Error('role servers do not expose the same frozen model');
  }
  const model = beforeDescriptions['baby-a'];
  const quantizationFamily = (model.quantization ?? '')
    .replace(/_M$/u, '')
    .toLowerCase();
  if (
    model.contextLength !== options.launch.contextLength ||
    Object.values(options.servers).some(
      (server) =>
        server.modelAlias !== model.modelId ||
        !server.modelFileType
          .toLowerCase()
          .replaceAll(' ', '_')
          .includes(quantizationFamily),
    )
  ) {
    throw new Error('client model description does not match live server attestation');
  }

  let createIndex = 0;
  const roleOrder: BabyRole[] = ['baby-a', 'baby-b'];
  const factory: LearnerAdapterFactory = {
    track: 'frozen-llm',
    create: () => {
      const role = roleOrder[createIndex];
      if (role === undefined) {
        throw new Error('qualification factory created more than two adapters');
      }
      createIndex += 1;
      return new FrozenLlmAdapter({
        client: options.clients[role],
        maxOutputTokens: options.launch.maxOutputTokens,
        temperature: options.launch.temperature,
        modelBudgetFraction: 0.95,
        maxModelTimeBudgetMs: options.launch.turnResponseBudgetMs,
      });
    },
  };
  const seed = options.seed ?? 'ald-real-frozen-model-qualification-v2';
  const result = await runLearnerAdapterConformance(factory, {
    deploymentMode: 'prototype',
    experimentId: 'E10',
    runId: 'frozen-model-qualification',
    modelRef: formatModelRef(model.modelId, model.weightsHash),
    turnResponseBudgetMs: options.launch.turnResponseBudgetMs,
    episodes,
    seed,
    roleReversalPeriod: 1,
    symbolInventorySize: options.symbolInventorySize ?? 32,
    messageLength: options.messageLength ?? 1,
    updatePolicy: false,
  });

  const afterDescriptions = {
    'baby-a': options.clients['baby-a'].describe(),
    'baby-b': options.clients['baby-b'].describe(),
  } as const;
  if (
    !descriptionsEqual(
      beforeDescriptions['baby-a'],
      afterDescriptions['baby-a'],
    ) ||
    !descriptionsEqual(
      beforeDescriptions['baby-b'],
      afterDescriptions['baby-b'],
    )
  ) {
    throw new Error('client model description changed during qualification');
  }

  const roleReport = (role: BabyRole): FrozenModelRoleQualification => {
    const ledger = result.ledgers[role];
    const hashes = result.policyHashes[role];
    const adapter = result.adapters[role];
    if (!(adapter instanceof FrozenLlmAdapter)) {
      throw new Error(`${role} did not use the frozen-LLM adapter`);
    }
    return {
      intentions: ledger.countOf('intention.recorded'),
      interpretations: ledger.countOf('interpretation.recorded'),
      firstEmissions: ledger.countOf('term.first_emitted'),
      firstReceipts: ledger.countOf('term.first_received'),
      hypotheses:
        ledger.countOf('hypothesis.created') +
        ledger.countOf('hypothesis.revised'),
      modelCalls: adapter.modelCallCount,
      policyHashes: [...hashes],
      privateMemoryChanged: new Set(hashes).size > 1,
      finalPolicyHash:
        hashes.at(-1) ?? hashCanonical(HASH_DOMAINS.policyCheckpoint, {}),
    };
  };
  const roles = {
    'baby-a': roleReport('baby-a'),
    'baby-b': roleReport('baby-b'),
  } as const;
  if (
    !roles['baby-a'].privateMemoryChanged ||
    !roles['baby-b'].privateMemoryChanged ||
    Object.values(result.adapters).some(
      (adapter) => adapter.updatePolicy !== undefined,
    )
  ) {
    throw new Error('frozen-weight/private-memory semantics were not demonstrated');
  }
  const liveCalls = roles['baby-a'].modelCalls + roles['baby-b'].modelCalls;
  if (liveCalls !== result.proposals) {
    throw new Error('not every proposal was backed by one live model call');
  }

  return {
    version: FROZEN_MODEL_QUALIFICATION_VERSION,
    claimBoundary: FROZEN_MODEL_QUALIFICATION_LABEL,
    softwareCommit: options.softwareCommit,
    executedAt: options.executedAt,
    runtime: options.runtime,
    model,
    launch: options.launch,
    servers: options.servers,
    reset: options.reset,
    isolation: {
      topology: 'dedicated-process-per-role-serialized',
      distinctClientInstances: true,
      distinctLoopbackEndpoints: true,
      oneSlotPerRole: true,
      promptCacheEnabled: false,
      roleProcessesOverlap: false,
    },
    seedHash: hashCanonical(HASH_DOMAINS.seed, seed),
    episodes: result.episodes,
    proposals: result.proposals,
    successes: result.successes,
    descriptiveSuccessRate: result.successRate,
    roles,
    toolBoundary: {
      requiredToolChoice: true,
      liveCalls,
      conformingCalls: result.proposals,
      violations: 0,
    },
    freezeSemantics: {
      weightUpdatePath: 'none',
      updatePolicyExposed: false,
      clientDescriptionsStable: true,
      exactWeightHashSharedByRoles: true,
      privateMemoryExpectedToChange: true,
    },
  };
}
