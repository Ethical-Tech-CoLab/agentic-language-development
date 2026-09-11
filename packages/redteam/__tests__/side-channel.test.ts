/** ALD-067 active attack orchestration over real Gateway and probe outputs. */
import { describe, expect, it } from 'vitest';
import { buildConformanceRunConfig } from '@ald/learners';
import { isolationProbe, type IsolationProbeResult } from '@ald/isolation';

import {
  SIDE_CHANNEL_ATTACK_CATEGORIES,
  SIDE_CHANNEL_MITIGATIONS,
  evaluateHostIsolationAttacks,
  runActiveTransportAttacks,
  runGatewaySideChannelAttacks,
  runHiddenStateCorrelationAttack,
  runSideChannelRedTeamSuite,
} from '../src/index.js';

function deniedProbe(processId: number): IsolationProbeResult {
  return {
    permissionModel: true,
    fsRead: 'denied',
    clipboard: 'denied',
    childProcess: 'denied',
    worker: 'denied',
    network: 'refused',
    envKeys: [],
    argvCount: 7,
    processId,
  };
}

describe('ALD-067 active side-channel harness', () => {
  it('maps every SPEC §10.3 category to one enforced mitigation', () => {
    expect(Object.keys(SIDE_CHANNEL_MITIGATIONS).sort()).toEqual(
      [...SIDE_CHANNEL_ATTACK_CATEGORIES].sort(),
    );
    expect(Object.values(SIDE_CHANNEL_MITIGATIONS).every(Boolean)).toBe(true);
  });
  it.each(['prototype', 'research-grade'] as const)(
    'actively rejects Gateway extraction attempts in %s mode',
    async (deploymentMode) => {
      const config = buildConformanceRunConfig('no-learning', {
        deploymentMode,
        runId: `redteam-${deploymentMode}`,
        seed: `redteam-${deploymentMode}`,
      });
      const report = await runGatewaySideChannelAttacks(config);

      expect(report.deploymentMode).toBe(deploymentMode);
      expect(report.passed).toBe(true);
      expect(report.attempts.map((attempt) => attempt.category)).toEqual([
        'carrier-bounds',
        'model-generated-identifiers',
        'silence-and-retry',
        'silence-and-retry',
        'response-size',
        'error-behavior',
      ]);
      expect(report.attempts.every((attempt) => attempt.auditRecorded)).toBe(true);
      expect(report.attempts.every((attempt) => !attempt.extractedByRecipient)).toBe(
        true,
      );
      expect(JSON.stringify(report)).not.toContain('cross-agent-marker');
    },
  );

  it('fails closed on any allowed host capability', () => {
    const passing = evaluateHostIsolationAttacks('research-grade', [
      deniedProbe(101),
      deniedProbe(102),
    ]);
    expect(passing.passed).toBe(true);

    const exposed = deniedProbe(102);
    exposed.network = 'allowed';
    const failing = evaluateHostIsolationAttacks('prototype', [
      deniedProbe(101),
      exposed,
    ]);
    expect(failing.passed).toBe(false);
    expect(failing.attempts.find((attempt) => attempt.category === 'network')).toMatchObject({
      blocked: false,
      extractedByRecipient: true,
    });
  });

  it('actively records why Prototype Mode cannot carry an isolation claim', async () => {
    const readPath = new URL('../../../SPECIFICATION.md', import.meta.url).pathname;
    const probes = await Promise.all([
      isolationProbe({ readPath }),
      isolationProbe({ readPath }),
    ]);
    const report = evaluateHostIsolationAttacks('prototype', probes);

    expect(report.passed).toBe(false);
    expect(report.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'filesystem', blocked: false }),
        expect.objectContaining({ category: 'process', blocked: false }),
        expect.objectContaining({ category: 'environment', blocked: false }),
      ]),
    );
  });

  it('actively samples timing, wire size, and response shape', async () => {
    const response = '{"turnComplete":true}';
    let clockTick = 0;
    const report = await runActiveTransportAttacks({
      deploymentMode: 'research-grade',
      now: () => {
        clockTick += 1;
        return clockTick;
      },
      samplesPerCondition: 3,
      conditions: [
        {
          label: 'accepted',
          execute: async () => ({ sizeBytes: 8192, responseBody: response }),
        },
        {
          label: 'rejected',
          execute: async () => ({ sizeBytes: 8192, responseBody: response }),
        },
      ],
      timingTolerance: { maxAbsoluteMeanDifference: 10 },
      sizeTolerance: { maxAbsoluteMeanDifference: 0 },
    });

    expect(report.passed).toBe(true);
    expect(report.timing.totalSamples).toBe(6);
    expect(report.sizeDecision.withinTolerance).toBe(true);
    expect(report.errorShape.groups).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain('turnComplete');
  });

  it('detects a deliberate hidden-state mapping through the affect channel', () => {
    const report = runHiddenStateCorrelationAttack();
    expect(report.attempts).toBe(64);
    expect(report.suspectedLeakage).toBe(true);
    expect(report.detectedBeforeClaim).toBe(true);
    expect(report.observedCmiBits).toBeGreaterThan(report.boundBits);
  });

  it.each([
    { deploymentMode: 'research-grade' as const, exposed: false },
    { deploymentMode: 'prototype' as const, exposed: true },
  ])('runs the complete comparison in $deploymentMode mode', async ({
    deploymentMode,
    exposed,
  }) => {
    const config = buildConformanceRunConfig('no-learning', {
      deploymentMode,
      runId: `redteam-suite-${deploymentMode}`,
      seed: `redteam-suite-${deploymentMode}`,
    });
    const second = deniedProbe(302);
    if (exposed) {
      second.fsRead = 'allowed';
      second.clipboard = 'allowed';
      second.childProcess = 'allowed';
      second.worker = 'allowed';
      second.network = 'allowed';
      second.envKeys = ['PATH'];
    }
    const response = '{"turnComplete":true}';
    let clockTick = 0;
    const report = await runSideChannelRedTeamSuite({
      config,
      hostProbes: [deniedProbe(301), second],
      transport: {
        now: () => {
          clockTick += 1;
          return clockTick;
        },
        samplesPerCondition: 2,
        timingTolerance: { maxAbsoluteMeanDifference: 10 },
        sizeTolerance: { maxAbsoluteMeanDifference: 0 },
        conditions: [
          {
            label: 'accepted',
            execute: async () => ({ sizeBytes: 8192, responseBody: response }),
          },
          {
            label: 'rejected',
            execute: async () => ({ sizeBytes: 8192, responseBody: response }),
          },
        ],
      },
    });

    expect(Object.keys(report.categories).sort()).toEqual(
      [...SIDE_CHANNEL_ATTACK_CATEGORIES].sort(),
    );
    expect(report.passed).toBe(!exposed);
    expect(report.claimEligible).toBe(deploymentMode === 'research-grade');
    expect(report.evidenceReady).toBe(false);
  });
});
