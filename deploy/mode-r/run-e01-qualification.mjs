import assert from 'node:assert/strict';

import { createIsolatedAdapterFactory } from '@ald/isolation';
import {
  buildConformanceRunConfig,
  loadLearnerContract,
  RecordingLedgerClient,
} from '@ald/learners';
import {
  evaluateHostIsolationAttacks,
  runActiveTransportAttacks,
  runSideChannelRedTeamSuite,
  SIDE_CHANNEL_ATTACK_CATEGORIES,
} from '@ald/redteam';
import { fixedTokenInventory } from '@ald/types';

const PORT = 4318;
const slot = Number(process.argv[2]);
const seed = process.argv[3];
if (!Number.isInteger(slot) || slot < 1 || typeof seed !== 'string' || !/^[a-f0-9]{64}$/u.test(seed)) {
  throw new Error('usage: run-e01-qualification.mjs <positive-slot> <64-hex-seed>');
}
const runId = `run-e01-qualified-${String(slot).padStart(2, '0')}`;

function factoryFor(host, label) {
  return createIsolatedAdapterFactory({
    track: 'no-learning',
    transport: 'container',
    endpoint: {
      host,
      port: PORT,
      attempts: 40,
      retryDelayMs: 250,
      timeoutMs: 500,
      hostLabel: label,
    },
    timing: 'normalized',
    deadlineMs: 1_000,
  });
}

async function initialized(host, role) {
  const factory = factoryFor(host, role);
  const adapter = factory.create();
  const config = buildConformanceRunConfig('no-learning', {
    deploymentMode: 'research-grade',
    runId,
    seed: `${seed}-${role}`,
    learningSignal: 'none',
  });
  await adapter.init({
    runId,
    role,
    babyId: role === 'baby-a' ? 'A' : 'B',
    config,
    learnerContract: loadLearnerContract('no-learning'),
    seed: `${seed}-private-${role}`,
    symbolInventory: fixedTokenInventory(config.symbolInventorySize),
    ledger: new RecordingLedgerClient(runId, role),
  });
  return { adapter, config, factory };
}

async function transportObservation(adapter, execute) {
  const before = adapter.transportStats?.bytesIn ?? 0;
  await execute();
  const after = adapter.transportStats?.bytesIn ?? 0;
  return {
    sizeBytes: after - before,
    responseBody: '{"turnComplete":true}',
  };
}

function transportAttackOptions(adapter) {
  return {
    // 47 observations per label plus the six Gateway attacks equals exactly
    // 100 recipient-visible attempts in each registered topology slot.
    samplesPerCondition: 47,
    timingTolerance: { maxAbsoluteMeanDifference: 100 },
    sizeTolerance: { maxAbsoluteMeanDifference: 0 },
    conditions: [
      {
        label: 'accepted',
        execute: () =>
          transportObservation(adapter, () =>
            adapter.observe({
              runId,
              turn: 2,
              recipient: 'baby-a',
              encoding: 'opaque-numeric',
              payload: [[0, 1, 1], [1, 0, 0]],
              scenarioRef: `scenario:e01:${seed}`,
            }),
          ),
      },
      {
        label: 'rejected',
        execute: () =>
          transportObservation(adapter, async () => {
            try {
              await adapter.receive({
                runId,
                turn: 2,
                logicalSender: 'baby-b',
                carrier: 'fixed-token',
                publicArtifact: { symbols: 'invalid' },
                channelEventHash: `sha256:${'0'.repeat(64)}`,
              });
              throw new Error('malformed delivery unexpectedly reached the adapter');
            } catch (error) {
              assert.equal(error?.code, 'host-error');
            }
          }),
      },
    ],
  };
}

function exposedProbe(processId) {
  return {
    permissionModel: false,
    fsRead: 'allowed',
    clipboard: 'allowed',
    childProcess: 'allowed',
    worker: 'allowed',
    network: 'allowed',
    envKeys: ['PATH'],
    argvCount: 1,
    processId,
  };
}

async function detectorPositiveControls() {
  const host = evaluateHostIsolationAttacks('prototype', [
    exposedProbe(1),
    exposedProbe(2),
  ]);
  let time = 0;
  let pendingDuration = 0;
  const transport = await runActiveTransportAttacks({
    deploymentMode: 'prototype',
    samplesPerCondition: 3,
    timingTolerance: { maxAbsoluteMeanDifference: 0 },
    sizeTolerance: { maxAbsoluteMeanDifference: 0 },
    now: () => {
      time += pendingDuration;
      pendingDuration = 0;
      return time;
    },
    conditions: [
      {
        label: 'accepted',
        execute: async () => {
          pendingDuration = 1;
          return { sizeBytes: 128, responseBody: '{"status":"accepted"}' };
        },
      },
      {
        label: 'rejected',
        execute: async () => {
          pendingDuration = 20;
          return { sizeBytes: 32, responseBody: '{"status":"rejected"}' };
        },
      },
    ],
  });
  return {
    hostExposureDetected: !host.passed && host.attempts.every((attempt) => !attempt.blocked),
    timingLeakDetected: !transport.timingDecision.withinTolerance,
    sizeLeakDetected: !transport.sizeDecision.withinTolerance,
    errorShapeLeakDetected: !transport.errorDecision.withinTolerance,
  };
}

const a = await initialized('baby-a', 'baby-a');
const b = await initialized('baby-b', 'baby-b');
try {
  assert.equal(a.adapter.isolation.boundary, 'separate-container');
  assert.equal(b.adapter.isolation.boundary, 'separate-container');
  assert.ok(a.adapter.isolation.containerId);
  assert.ok(b.adapter.isolation.containerId);
  assert.notEqual(a.adapter.isolation.containerId, b.adapter.isolation.containerId);

  const [probeA, probeB] = await Promise.all([
    a.adapter.probeIsolation({
      readPath: '/run/ald-peer-secret',
      connect: { host: 'baby-b', port: PORT, timeoutMs: 300 },
    }),
    b.adapter.probeIsolation({
      readPath: '/run/ald-peer-secret',
      connect: { host: 'baby-a', port: PORT, timeoutMs: 300 },
    }),
  ]);
  const report = await runSideChannelRedTeamSuite({
    config: a.config,
    hostProbes: [probeA, probeB],
    transport: transportAttackOptions(a.adapter),
  });
  const positiveControls = await detectorPositiveControls();
  const primaryAttackAttempts =
    report.gateway.attempts.length + report.transport.timing.totalSamples;
  const allPositiveControlsDetected = Object.values(positiveControls).every(Boolean);
  const passed =
    report.passed &&
    report.claimEligible &&
    primaryAttackAttempts === 100 &&
    report.host.attempts.length === 5 &&
    Object.keys(report.categories).length === SIDE_CHANNEL_ATTACK_CATEGORIES.length &&
    allPositiveControlsDetected;
  const output = {
    schemaVersion: 1,
    slot,
    scenarioSeed: seed,
    runId,
    topology: {
      mode: 'research-grade',
      boundary: 'separate-container',
      containerIds: [a.adapter.isolation.containerId, b.adapter.isolation.containerId],
      distinctLearnerContainers:
        a.adapter.isolation.containerId !== b.adapter.isolation.containerId,
      directPeerRoutes: [probeA.network, probeB.network],
    },
    primaryAttackAttempts,
    hostCapabilityAttempts: report.host.attempts.length,
    registeredCategories: [...SIDE_CHANNEL_ATTACK_CATEGORIES],
    categoryDecisions: report.categories,
    gateway: report.gateway,
    host: report.host,
    transport: report.transport,
    correlationDetector: report.correlation,
    positiveControls,
    allPositiveControlsDetected,
    passed,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await Promise.all([a.factory.dispose(), b.factory.dispose()]);
}
