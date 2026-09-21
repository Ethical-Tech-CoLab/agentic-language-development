import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { connectAnchorServiceRpc } from '@ald/anchor';
import { connectCheckpointServiceRpc } from '@ald/checkpoint';
import { connectControllerEvidenceRpc } from '@ald/evidence';
import {
  connectSymbolGatewayRpc,
  createGatewayRelayAdapterFactory,
} from '@ald/gateway';
import {
  connectAuditInterpreterRpc,
  createNurseryRuntime,
} from '@ald/orchestrator';
import { RECURRENT_ARCHITECTURE } from '@ald/learners';
import { SIGNER_DOMAINS } from '@ald/types';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const stage = process.env.ALD_MODE_R_CONTROLLER_STAGE ?? 'complete';
assert.ok(['complete', 'prepare-recovery', 'recover', 'lv01-fixture', 'lv01-paired-branch'].includes(stage),
  `unsupported ALD_MODE_R_CONTROLLER_STAGE ${stage}`);
const publicKeyRoot = required('ALD_MODE_R_PUBLIC_KEYS_ROOT');
const publicKeys = await Promise.all(SIGNER_DOMAINS.map((domain) =>
  retry(`${domain} public key`, () => readJson(`${publicKeyRoot}/${domain}.json`))));
const [controller, audit, checkpoint, anchor] = await Promise.all([
  retry('controller writer', () => connectControllerEvidenceRpc(
    required('ALD_MODE_R_CONTROLLER_WRITER'), config.runId)),
  retry('Audit Interpreter', () => connectAuditInterpreterRpc(
    required('ALD_MODE_R_AUDIT_SERVICE'), config.runId)),
  retry('Checkpoint Service', () => connectCheckpointServiceRpc(
    required('ALD_MODE_R_CHECKPOINT_SERVICE'), config.runId)),
  retry('Anchor Service', () => connectAnchorServiceRpc(
    required('ALD_MODE_R_ANCHOR_SERVICE'), config.runId, {
      anchorClass: 'simulated',
      network: 'base-sepolia',
    })),
]);
const lv01LearnerOptions = {
  backbone: RECURRENT_ARCHITECTURE,
  learningRate: 0.003,
  temperature: 1,
  recurrent: {
    hiddenSize: 16,
    ppoClip: 0.2,
    ppoEpochs: 4,
    valueLossCoefficient: 0.5,
    maxGradientNorm: 1,
  },
};
const learnerOptionsFor = (track) => track === 'scratch-rl'
  ? { learnerOptions: lv01LearnerOptions }
  : {};
const factories = new Map([
  ['baby-a', createGatewayRelayAdapterFactory({
    track: config.babyA.track,
    socketPath: required('ALD_MODE_R_BABY_A_RELAY'),
    hostLabel: 'baby-a-gateway-relay',
    timing: 'normalized',
    deadlineMs: 1_000,
    ...learnerOptionsFor(config.babyA.track),
  })],
  ['baby-b', createGatewayRelayAdapterFactory({
    track: config.babyB.track,
    socketPath: required('ALD_MODE_R_BABY_B_RELAY'),
    hostLabel: 'baby-b-gateway-relay',
    timing: 'normalized',
    deadlineMs: 1_000,
    ...learnerOptionsFor(config.babyB.track),
  })],
]);
const signers = {
  runId: config.runId,
  signer: () => { throw new Error('Controller holds no signer capability'); },
  publicKeys: () => publicKeys,
};
let gatewayProcessId;
const outputRoot = required('ALD_MODE_R_OUTPUT_ROOT');
const runtime = createNurseryRuntime({
  bundleRoot: join(outputRoot, 'bundles'),
  softwareCommit: required('ALD_SOFTWARE_COMMIT'),
  anchorPolicy: 'required',
  anchorPublisher: anchor.publisher,
  signerProvider: () => signers,
  adapterFactoryFor: (_runConfig, role) => factories.get(role),
  evidenceContextFactory: () => ({
    controller: controller.port,
    audit: audit.interpreter,
    checkpoints: checkpoint.service,
  }),
  gatewayFactory: async (input) => {
    const connected = await retry('Symbol Gateway', () =>
      connectSymbolGatewayRpc(required('ALD_MODE_R_GATEWAY_SOCKET'), input.context));
    gatewayProcessId = connected.processId;
    return connected.gateway;
  },
});

async function appendDelayedAudit() {
  const ledger = await controller.port.readEvents(config.runId, 'baby-a-ledger');
  const source = ledger.find((event) => {
    const value = JSON.parse(event.canonicalJson);
    return value.turn === 0;
  });
  if (!source) throw new Error('no eligible delayed audit source');
  await runtime.interpretAuditBatch({
    runId: config.runId,
    interpreterVersion: 'selected-application-development-v1',
    entries: [{
      babyId: 'A',
      sourceEntryHash: source.entryHash,
      content: {
        term: 'development-observation',
        hypothesis: 'the selected application path preserves delayed audit separation',
        evidence: 'bounded-development-application-execution',
      },
    }],
  });
  return (await controller.port.readEvents(config.runId, 'audit')).length;
}

async function writeResult(name, result) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, name), `${JSON.stringify(result, null, 2)}\n`);
}

async function runLv01Fixture() {
  assert.equal(config.experimentId, 'LV01');
  assert.equal(config.babyA.track, 'scratch-rl');
  assert.equal(config.babyB.track, 'scratch-rl');
  assert.ok(config.ledgerValuePlan !== undefined);
  await runtime.createRun(config);
  const summary = await runtime.runToCompletion(config.runId);
  assert.equal(summary.state, 'sealed');
  const records = await controller.port.readEvents(config.runId, 'turns');
  const checkpoints = await controller.port.readCheckpoints(config.runId);
  const bundle = await runtime.exportBundle(config.runId, join(outputRoot, 'bundle'));
  await writeResult('lv01-fixture-result.json', {
    schemaVersion: 1,
    classification: 'lv01-development-topology-fixture',
    researchFinding: false,
    scientificDisposition: 'not-tested',
    runId: config.runId,
    state: summary.state,
    trainingTurns: records.filter((event) => JSON.parse(event.canonicalJson).phase === 'running').length,
    evaluationTurns: records.filter((event) => JSON.parse(event.canonicalJson).phase === 'evaluating').length,
    checkpointCount: checkpoints.length,
    processIds: {
      controller: process.pid,
      evidenceWriter: controller.processId,
      gateway: gatewayProcessId,
      checkpoint: checkpoint.processId,
      anchor: anchor.processId,
      auditInterpreter: audit.processId,
    },
    bundleRunId: bundle.runId,
    claimBoundary: 'One local full-turn recurrent fixture through the selected application boundaries. This is not seven-branch LV01 qualification, a pilot, or a behavioral finding.',
  });
}

/** Execute one isolated derived branch; the outer collector owns pairing. */
async function runLv01PairedBranch() {
  assert.equal(config.experimentId, 'LV01');
  assert.equal(config.babyA.track, 'scratch-rl');
  assert.equal(config.babyB.track, 'scratch-rl');
  assert.ok(config.parentRunId !== undefined, 'paired branch requires a parent run');
  assert.ok(config.derivedFromCheckpointHash !== undefined,
    'paired branch requires a parent checkpoint');
  assert.ok(config.babyA.initialPolicyRef !== undefined,
    'paired branch requires baby-a parent policy');
  assert.ok(config.babyB.initialPolicyRef !== undefined,
    'paired branch requires baby-b parent policy');
  await runtime.createRun(config);
  const summary = await runtime.runToCompletion(config.runId);
  assert.equal(summary.state, 'sealed');
  const [turns, channels, checkpoints, bundle] = await Promise.all([
    controller.port.readEvents(config.runId, 'turns'),
    controller.port.readEvents(config.runId, 'channel'),
    controller.port.readCheckpoints(config.runId),
    runtime.exportBundle(config.runId, join(outputRoot, 'bundle')),
  ]);
  await writeResult('lv01-paired-branch-result.json', {
    schemaVersion: 1,
    classification: 'lv01-selected-paired-branch-development',
    researchFinding: false,
    scientificDisposition: 'not-tested',
    runId: config.runId,
    parentRunId: config.parentRunId,
    parentCheckpointHash: config.derivedFromCheckpointHash,
    communicationCondition: config.communicationCondition,
    state: summary.state,
    turnCount: turns.length,
    channelCount: channels.length,
    checkpointCount: checkpoints.length,
    bundleRunId: bundle.runId,
    claimBoundary: 'One derived LV01 branch through the selected topology. Pairing, prospective predictions, and cross-branch chronology are established only by the outer collector.',
  });
}

try {
  if (stage === 'lv01-fixture') {
    await runLv01Fixture();
  } else if (stage === 'lv01-paired-branch') {
    await runLv01PairedBranch();
  } else if (stage === 'prepare-recovery') {
    const created = await runtime.createRun(config);
    const first = await runtime.step(config.runId);
    const paused = await runtime.pause(config.runId, {
      actorId: 'qualification-operator',
      reasonCode: 'selected-lifecycle-restart',
      details: { stage: 'prepare-recovery' },
    });
    const checkpoints = await controller.port.readCheckpoints(config.runId);
    await writeResult('controller-prepare-result.json', {
      schemaVersion: 1,
      classification: 'selected-application-lifecycle-development',
      researchFinding: false,
      b12Closed: false,
      stage,
      runId: config.runId,
      createdState: created.state,
      firstTurn: first.turn,
      firstPhase: first.phase,
      pausedState: paused.state,
      pausedTurn: paused.turn,
      checkpointReasons: checkpoints.map((entry) => entry.reason),
      processIds: {
        controller: process.pid,
        evidenceWriter: controller.processId,
        gateway: gatewayProcessId,
        checkpoint: checkpoint.processId,
        anchor: anchor.processId,
        auditInterpreter: audit.processId,
      },
    });
  } else if (stage === 'recover') {
    const recovered = await runtime.recover(config.runId);
    const resumed = await runtime.resume(config.runId, {
      actorId: 'qualification-operator',
      reasonCode: 'selected-lifecycle-prefix-verified',
      details: { stage: 'recover' },
    });
    const second = await runtime.step(config.runId);
    const auditEntryCount = await appendDelayedAudit();
    const evaluation = await runtime.step(config.runId);
    const final = runtime.getRun(config.runId);
    assert.ok(final !== undefined);
    const checkpoints = await controller.port.readCheckpoints(config.runId);
    const interventions = await controller.port.readEvents(config.runId, 'intervention');
    const bundle = await runtime.exportBundle(config.runId, join(outputRoot, 'bundle'));
    await writeResult('controller-recovery-result.json', {
      schemaVersion: 1,
      classification: 'selected-application-lifecycle-development',
      researchFinding: false,
      b12Closed: false,
      stage,
      runId: config.runId,
      recoveredState: recovered.state,
      recoveredTurn: recovered.turn,
      resumedState: resumed.state,
      secondTurn: second.turn,
      secondPhase: second.phase,
      evaluationTurn: evaluation.turn,
      evaluationPhase: evaluation.phase,
      finalState: final.state,
      finalTurn: final.turn,
      auditEntryCount,
      checkpointReasons: checkpoints.map((entry) => entry.reason),
      interventionTypes: interventions.map((entry) =>
        JSON.parse(entry.canonicalJson).eventType),
      processIds: {
        controller: process.pid,
        evidenceWriter: controller.processId,
        gateway: gatewayProcessId,
        checkpoint: checkpoint.processId,
        anchor: anchor.processId,
        auditInterpreter: audit.processId,
      },
      bundleRunId: bundle.runId,
    });
  } else {
    await runtime.createRun(config);
    const first = await runtime.step(config.runId);
    const second = await runtime.step(config.runId);
    const auditEntryCount = await appendDelayedAudit();
    const bundle = await runtime.exportBundle(config.runId, join(outputRoot, 'bundle'));
    await writeResult('controller-result.json', {
      schemaVersion: 1,
      classification: 'selected-application-development-execution',
      researchFinding: false,
      b12Closed: false,
      publicChainTransaction: false,
      externalSpendingUsd: 0,
      runId: config.runId,
      turns: [first.turn, second.turn],
      auditEntryCount,
      processIds: {
        controller: process.pid,
        evidenceWriter: controller.processId,
        gateway: gatewayProcessId,
        checkpoint: checkpoint.processId,
        anchor: anchor.processId,
        auditInterpreter: audit.processId,
      },
      bundleRunId: bundle.runId,
    });
  }
} finally {
  await Promise.all([...factories.values()].map((factory) => factory.dispose()));
}
