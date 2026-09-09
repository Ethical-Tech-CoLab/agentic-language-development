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
const requestedTrack = process.argv[3] ?? 'no-learning';

function factoryFor(host, label, track = requestedTrack) {
  return createIsolatedAdapterFactory({
    track,
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

async function initialized(host, role, track = requestedTrack) {
  const factory = factoryFor(host, role, track);
  const adapter = factory.create();
  const learningSignal =
    track === 'self-supervised' ? 'self-supervised' :
    track === 'no-learning' ? 'none' : 'extrinsic-task';
  const config = buildConformanceRunConfig(track, {
    deploymentMode: 'research-grade',
    runId: `mode-r-${mode}-${track}`,
    seed: `mode-r-${mode}-${track}-${role}`,
    learningSignal,
  });
  await adapter.init({
    runId: config.runId,
    role,
    babyId: role === 'baby-a' ? 'A' : 'B',
    config,
    learnerContract: loadLearnerContract(track),
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

async function exerciseTraining(adapter, role, track) {
  const runId = `mode-r-${mode}-${track}`;
  await adapter.observe({
    runId,
    turn: 1,
    recipient: role,
    encoding: 'opaque-numeric',
    payload: [[0, 1, 1], [1, 0, 0]],
    scenarioRef: `scenario:mode-r-training-${track}`,
  });
  await adapter.act({
    turn: 1,
    role: 'sender',
    responseBudgetMs: 100,
    availableActions: ['emit_symbols'],
  });
  await adapter.onOutcome({
    runId,
    turn: 1,
    role: 'sender',
    success: true,
    reward: track === 'self-supervised' ? null : 1,
    payload: [1],
  });

  const before = JSON.stringify(adapter.exportPolicy());
  let counterpartStateRead = false;
  const batch = {
    runId,
    turns: [1],
    learningSignal:
      track === 'self-supervised' ? 'self-supervised' : 'extrinsic-task',
  };
  Object.defineProperty(batch, 'counterpartState', {
    enumerable: true,
    get() {
      counterpartStateRead = true;
      throw new Error('counterpart state crossed the training boundary');
    },
  });
  await adapter.updatePolicy(batch);
  const after = JSON.stringify(adapter.exportPolicy());
  assert.equal(counterpartStateRead, false);
  assert.notEqual(after, before, `${track} must perform a real local-buffer update`);
  assert.equal(after.includes('counterpart state'), false);
  return { counterpartStateRead, policyChanged: true };
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

async function runTraining() {
  assert.ok(
    ['scratch-rl', 'self-supervised', 'hybrid'].includes(requestedTrack),
    `unsupported training track: ${requestedTrack}`,
  );
  const a = await initialized('baby-a', 'baby-a', requestedTrack);
  const b = await initialized('baby-b', 'baby-b', requestedTrack);
  try {
    assert.equal(a.adapter.isolation.boundary, 'separate-container');
    assert.equal(b.adapter.isolation.boundary, 'separate-container');
    assert.ok(a.adapter.isolation.containerId);
    assert.ok(b.adapter.isolation.containerId);
    assert.notEqual(a.adapter.isolation.containerId, b.adapter.isolation.containerId);
    const results = await Promise.all([
      exerciseTraining(a.adapter, 'baby-a', requestedTrack),
      exerciseTraining(b.adapter, 'baby-b', requestedTrack),
    ]);
    process.stdout.write(`${JSON.stringify({
      mode: 'research-grade-training',
      track: requestedTrack,
      containers: [a.adapter.isolation.containerId, b.adapter.isolation.containerId],
      updateSource: 'private-local-buffer',
      counterpartStateRead: results.some((result) => result.counterpartStateRead),
      policiesChanged: results.every((result) => result.policyChanged),
    })}\n`);
  } finally {
    await Promise.all([a.factory.dispose(), b.factory.dispose()]);
  }
}

if (mode === 'both') {
  await runBoth();
} else if (mode === 'survivor') {
  await runSurvivor();
} else if (mode === 'training') {
  await runTraining();
} else {
  throw new Error(`unknown verification mode: ${mode}`);
}
