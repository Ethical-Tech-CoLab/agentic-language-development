import { describe, expect, it } from 'vitest';

import {
  EXPECTED_SCHEMA_EXPORTS,
  RunConfigSchema,
  schemaRegistry,
} from '../src/index.js';

const hash = `sha256:${'a'.repeat(64)}`;

describe('schema registry', () => {
  it('exports every schema required by specification section 11', () => {
    expect(Object.keys(schemaRegistry).sort()).toEqual(
      [...EXPECTED_SCHEMA_EXPORTS].sort(),
    );
  });

  it('accepts a valid root run configuration', () => {
    const result = RunConfigSchema.safeParse({
      version: 1,
      runId: 'run-001',
      deploymentMode: 'prototype',
      babyA: {
        track: 'scratch-rl',
        modelRef: 'gru-v1',
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'scratch-rl',
        modelRef: 'gru-v1',
        trainingIsolation: 'independent',
      },
      symmetricTracks: true,
      learningSignal: 'extrinsic-task',
      communicationCondition: 'normal',
      interactionMode: 'cooperative-signaling',
      carrierMode: 'fixed-token',
      affectMode: 'none',
      affectWindowSchedule: 'post-outcome',
      observationEncoding: 'opaque-numeric',
      roleReversalPeriod: 1,
      turnResponseBudgetMs: 30_000,
      maxTurnsPerRun: 100,
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
      scenarioBundleHash: hash,
      promptBundleHash: hash,
      protocolGitCommit: 'abcdef0',
      preRegistrationHash: hash,
      randomSeed: 'seed-001',
      experimentId: 'E11',
    });

    expect(result.success).toBe(true);
  });

  it('rejects incomplete derived-run lineage', () => {
    const result = RunConfigSchema.safeParse({
      version: 1,
      runId: 'run-derived',
      parentRunId: 'run-parent',
      deploymentMode: 'prototype',
      babyA: {
        track: 'no-learning',
        modelRef: 'fixed-v1',
        trainingIsolation: 'independent',
      },
      babyB: {
        track: 'no-learning',
        modelRef: 'fixed-v1',
        trainingIsolation: 'independent',
      },
      symmetricTracks: true,
      learningSignal: 'none',
      communicationCondition: 'normal',
      interactionMode: 'cooperative-signaling',
      carrierMode: 'fixed-token',
      affectMode: 'none',
      affectWindowSchedule: 'post-outcome',
      observationEncoding: 'opaque-numeric',
      roleReversalPeriod: 1,
      turnResponseBudgetMs: 30_000,
      maxTurnsPerRun: 100,
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
      scenarioBundleHash: hash,
      promptBundleHash: hash,
      protocolGitCommit: 'abcdef0',
      preRegistrationHash: hash,
      randomSeed: 'seed-002',
      experimentId: 'E30',
    });

    expect(result.success).toBe(false);
  });
});
