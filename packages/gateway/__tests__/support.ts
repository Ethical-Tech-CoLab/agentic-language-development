import { fixedTokenInventory } from '@ald/types';
import type {
  GatewayRunContext,
  GatewayTurnContext,
  LedgerEventDraft,
  RunConfig,
  TurnProposalEnvelope,
} from '@ald/types';

import { SymbolGatewayImpl, type SymbolGatewayOptions } from '../src/symbol-gateway.js';
import { FakeEvidenceWriter, StepClock } from './fake-evidence-writer.js';

export const RUN_ID = 'run-gateway-001';
export const SEED = 'seed-gateway-001';

function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

export function runConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    version: 1,
    runId: RUN_ID,
    deploymentMode: 'prototype',
    babyA: {
      track: 'no-learning',
      modelRef: 'reference-a',
      trainingIsolation: 'independent',
    },
    babyB: {
      track: 'no-learning',
      modelRef: 'reference-b',
      trainingIsolation: 'independent',
    },
    symmetricTracks: true,
    learningSignal: 'none',
    communicationCondition: 'normal',
    interactionMode: 'cooperative-signaling',
    carrierMode: 'fixed-token',
    symbolInventorySize: 32,
    maxSymbolsPerMessage: 4,
    affectMode: 'none',
    affectWindowSchedule: 'every-4-turns',
    observationEncoding: 'opaque-numeric',
    roleReversalPeriod: 1,
    turnResponseBudgetMs: 30_000,
    maxTurnsPerRun: 200,
    maxConsecutiveRejections: 5,
    ledgerLagTurns: 0,
    curriculumMode: 'fixed-schedule',
    cipherThreatModel: 'post-run-disclosure',
    interventionSuiteThreshold: 0.5,
    evaluationSeeds: 4,
    checkpointEventInterval: 25,
    checkpointTimeIntervalMs: 60_000,
    anchorNetwork: 'base-sepolia',
    finalityPolicy: '1-confirmation',
    prototypeRetentionDays: 30,
    scenarioBundleHash: hash('a'),
    promptBundleHash: hash('b'),
    protocolGitCommit: 'e2b1c0d4f5a6978877665544332211aabbccddee',
    preRegistrationHash: hash('c'),
    randomSeed: SEED,
    experimentId: 'E00',
    ...overrides,
  } as RunConfig;
}

export function runContext(
  overrides: Partial<RunConfig> = {},
  contextOverrides: Partial<GatewayRunContext> = {},
): GatewayRunContext {
  const config = runConfig(overrides);
  return {
    runId: config.runId,
    config,
    symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
    seed: SEED,
    ...contextOverrides,
  };
}

export interface Harness {
  gateway: SymbolGatewayImpl;
  evidence: FakeEvidenceWriter;
  context: GatewayRunContext;
}

/** A registered run, a fresh in-memory writer, and a Gateway over both. */
export function harness(
  overrides: Partial<RunConfig> = {},
  options: SymbolGatewayOptions = {},
  contextOverrides: Partial<GatewayRunContext> = {},
): Harness {
  const context = runContext(overrides, contextOverrides);
  const evidence = FakeEvidenceWriter.forRun(context.runId, new StepClock());
  evidence.registerRun(context.config);
  return {
    gateway: new SymbolGatewayImpl(context, evidence, options),
    evidence,
    context,
  };
}

export function turn(
  overrides: Partial<GatewayTurnContext> = {},
): GatewayTurnContext {
  return {
    turn: 1,
    sender: 'baby-a',
    recipient: 'baby-b',
    ...overrides,
  };
}

export function intentionDraft(
  overrides: Partial<LedgerEventDraft> = {},
): LedgerEventDraft {
  return {
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: 'subject-intention',
    content: { artifactRef: 'artifact-1' },
    blindingNonce: 'nonce-intention',
    evidenceRefs: [],
    ...overrides,
  };
}

export function interpretationDraft(
  overrides: Partial<LedgerEventDraft> = {},
): LedgerEventDraft {
  return {
    eventType: 'interpretation.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: 'subject-interpretation',
    content: { artifactRef: 'artifact-1' },
    blindingNonce: 'nonce-interpretation',
    evidenceRefs: [],
    ...overrides,
  };
}

export function symbolEnvelope(
  symbols: string[],
  draft: LedgerEventDraft = intentionDraft(),
): TurnProposalEnvelope {
  return {
    proposal: { kind: 'emit_symbols', publicArtifact: { symbols } },
    privateLedgerDraft: draft,
  };
}

/** Casts an intentionally malformed submission onto the contract type. */
export function asEnvelope(value: unknown): TurnProposalEnvelope {
  return value as TurnProposalEnvelope;
}
