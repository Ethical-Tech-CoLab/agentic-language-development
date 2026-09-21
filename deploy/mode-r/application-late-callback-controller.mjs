import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

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
import { SIGNER_DOMAINS } from '@ald/types';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const outputRoot = required('ALD_MODE_R_OUTPUT_ROOT');
const settleMs = Number(required('ALD_MODE_R_LATE_CALLBACK_SETTLE_MS'));
assert.ok(Number.isSafeInteger(settleMs) && settleMs > 1_000);
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
const factories = new Map([
  ['baby-a', createGatewayRelayAdapterFactory({
    track: config.babyA.track,
    socketPath: required('ALD_MODE_R_BABY_A_RELAY'),
    hostLabel: 'baby-a-gateway-relay',
    timing: 'normalized',
    deadlineMs: 1_000,
  })],
  ['baby-b', createGatewayRelayAdapterFactory({
    track: config.babyB.track,
    socketPath: required('ALD_MODE_R_BABY_B_RELAY'),
    hostLabel: 'baby-b-gateway-relay',
    timing: 'normalized',
    deadlineMs: 1_000,
  })],
]);
const signers = {
  runId: config.runId,
  signer: () => { throw new Error('Controller holds no signer capability'); },
  publicKeys: () => publicKeys,
};
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
    return connected.gateway;
  },
});

function errorRecord(error) {
  return {
    name: error instanceof Error ? error.name : 'NonErrorThrow',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function rejected(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return errorRecord(error);
  }
}

async function counts() {
  const streams = await Promise.all([
    'turns', 'channel', 'baby-a-ledger', 'baby-b-ledger', 'intervention',
  ].map((stream) => controller.port.readEvents(config.runId, stream)));
  const checkpoints = await controller.port.readCheckpoints(config.runId);
  return {
    turns: streams[0].length,
    channel: streams[1].length,
    babyALedger: streams[2].length,
    babyBLedger: streams[3].length,
    interventions: streams[4].length,
    checkpoints: checkpoints.length,
  };
}

try {
  const created = await runtime.createRun(config);
  const before = await counts();
  const step = await runtime.step(config.runId);
  const afterTimeout = await counts();
  await delay(settleMs);
  const afterLateWindow = await counts();
  const resumeError = await rejected(() => runtime.resume(config.runId, {
    actorId: 'qualification-operator',
    reasonCode: 'late-callback-resume-refusal-check',
  }));
  const stepError = await rejected(() => runtime.step(config.runId));
  const afterRefusals = await counts();
  const interventions = await controller.port.readEvents(config.runId, 'intervention');
  const deadlineEvents = interventions.map((event) => JSON.parse(event.canonicalJson))
    .filter((event) => event.reasonCode === 'turn-deadline-forfeit');
  const bundle = await runtime.exportBundle(
    config.runId, join(outputRoot, 'late-callback-bundle'));
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'late-callback-result.json'), `${JSON.stringify({
    schemaVersion: 1,
    classification: 'selected-application-late-callback-development',
    researchFinding: false,
    b12Closed: false,
    runId: config.runId,
    createdState: created.state,
    step: {
      turn: step.turn,
      phase: step.phase,
      state: step.state,
      outcome: step.outcome,
      channelValidation: step.channelEvent?.gatewayValidationResult ?? null,
      channelReasonCode: step.channelEvent?.reasonCode ?? null,
      logicalSender: step.channelEvent?.logicalSender ?? null,
    },
    before,
    afterTimeout,
    afterLateWindow,
    resumeError,
    stepError,
    afterRefusals,
    deadlineEvents,
    bundleRunId: bundle.runId,
  }, null, 2)}\n`);
} finally {
  await Promise.all([...factories.values()].map((factory) => factory.dispose()));
}
