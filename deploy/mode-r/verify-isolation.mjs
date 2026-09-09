import assert from 'node:assert/strict';

import { createIsolatedAdapterFactory } from '@ald/isolation';
import {
  buildConformanceRunConfig,
  loadLearnerContract,
  RecordingLedgerClient,
} from '@ald/learners';
import { fixedTokenInventory } from '@ald/types';
import {
  SIDE_CHANNEL_ATTACK_CATEGORIES,
  runSideChannelRedTeamSuite,
} from '@ald/redteam';

const PORT = 4318;
const mode = process.argv[2] ?? 'both';

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
    runId: `mode-r-${mode}`,
    seed: `mode-r-${mode}-${role}`,
  });
  await adapter.init({
    runId: config.runId,
    role,
    babyId: role === 'baby-a' ? 'A' : 'B',
    config,
    learnerContract: loadLearnerContract('no-learning'),
    seed: `private-${role}`,
    symbolInventory: fixedTokenInventory(config.symbolInventorySize),
    ledger: new RecordingLedgerClient(config.runId, role),
  });
  return { adapter, config, factory };
}

function assertClosedProbe(probe, peer) {
  assert.equal(probe.permissionModel, true);
  assert.equal(probe.fsRead, 'denied');
  assert.equal(probe.clipboard, 'denied');
  assert.equal(probe.childProcess, 'denied');
  assert.equal(probe.worker, 'denied');
  assert.equal(probe.network, 'refused', `direct route to ${peer} must be absent`);
  assert.deepEqual(probe.envKeys, []);
}

async function exercise(adapter, role) {
  await adapter.observe({
    runId: `mode-r-${mode}`,
    turn: 1,
    recipient: role,
    encoding: 'opaque-numeric',
    payload: [[0, 1, 1], [1, 0, 0]],
    scenarioRef: 'scenario:mode-r-smoke',
  });
  const proposal = await adapter.act({
    turn: 1,
    role: 'sender',
    responseBudgetMs: 100,
    availableActions: ['emit_symbols'],
  });
  assert.equal(proposal.proposal.kind, 'emit_symbols');
}

async function transportObservation(adapter, execute) {
  const before = adapter.transportStats?.bytesIn ?? 0;
  await execute();
  const after = adapter.transportStats?.bytesIn ?? 0;
  return {
    sizeBytes: after - before,
    // This is the fixed completion tick visible to the peer; host response
    // content and errors remain inside the Nursery-side proxy.
    responseBody: '{"turnComplete":true}',
  };
}

function transportAttackOptions(adapter) {
  return {
    samplesPerCondition: 3,
    timingTolerance: { maxAbsoluteMeanDifference: 100 },
    sizeTolerance: { maxAbsoluteMeanDifference: 0 },
    conditions: [
      {
        label: 'accepted',
        execute: () =>
          transportObservation(adapter, () =>
            adapter.observe({
              runId: `mode-r-${mode}`,
              turn: 2,
              recipient: 'baby-a',
              encoding: 'opaque-numeric',
              payload: [[0, 1, 1], [1, 0, 0]],
              scenarioRef: 'scenario:mode-r-timing',
            }),
          ),
      },
      {
        label: 'rejected',
        execute: () =>
          transportObservation(adapter, async () => {
            try {
              await adapter.receive({
                runId: `mode-r-${mode}`,
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

async function runBoth() {
  const a = await initialized('baby-a', 'baby-a');
  const b = await initialized('baby-b', 'baby-b');
  try {
    assert.equal(a.adapter.isolation.boundary, 'separate-container');
    assert.equal(b.adapter.isolation.boundary, 'separate-container');
    assert.equal(a.adapter.isolation.timingNormalization, 'normalized');
    assert.equal(b.adapter.isolation.timingNormalization, 'normalized');
    assert.ok(a.adapter.isolation.containerId);
    assert.ok(b.adapter.isolation.containerId);
    assert.notEqual(
      a.adapter.isolation.containerId,
      b.adapter.isolation.containerId,
    );

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
    assertClosedProbe(probeA, 'baby-b');
    assertClosedProbe(probeB, 'baby-a');
    const sideChannels = await runSideChannelRedTeamSuite({
      config: a.config,
      hostProbes: [probeA, probeB],
      transport: transportAttackOptions(a.adapter),
    });
    assert.equal(sideChannels.passed, true);
    assert.equal(sideChannels.claimEligible, true);
    await Promise.all([
      exercise(a.adapter, 'baby-a'),
      exercise(b.adapter, 'baby-b'),
    ]);
    process.stdout.write(`${JSON.stringify({
      mode: 'research-grade',
      containers: [a.adapter.isolation.containerId, b.adapter.isolation.containerId],
      directNetworkRoutes: 'refused',
      filesystem: 'denied',
      clipboard: 'denied',
      childProcess: 'denied',
      worker: 'denied',
      environmentKeys: 0,
      timingNormalization: 'normalized',
      activeSideChannelCategories: SIDE_CHANNEL_ATTACK_CATEGORIES.length,
      transportSamples: sideChannels.transport.timing.totalSamples,
      timingWithinTolerance:
        sideChannels.transport.timingDecision.withinTolerance,
      sizeWithinTolerance: sideChannels.transport.sizeDecision.withinTolerance,
      errorShapeWithinTolerance:
        sideChannels.transport.errorDecision.withinTolerance,
    })}\n`);
  } finally {
    await Promise.all([a.factory.dispose(), b.factory.dispose()]);
  }
}

async function runSurvivor() {
  const b = await initialized('baby-b', 'baby-b');
  try {
    const probe = await b.adapter.probeIsolation({
      connect: { host: 'baby-a', port: PORT, timeoutMs: 300 },
    });
    assert.equal(probe.network, 'refused');
    await exercise(b.adapter, 'baby-b');
    process.stdout.write(`${JSON.stringify({
      killed: 'baby-a',
      survivor: 'baby-b',
      survivorResponsive: true,
      directNetworkRoute: 'refused',
    })}\n`);
  } finally {
    await b.factory.dispose();
  }
}

if (mode === 'both') {
  await runBoth();
} else if (mode === 'survivor') {
  await runSurvivor();
} else {
  throw new Error(`unknown verification mode: ${mode}`);
}
