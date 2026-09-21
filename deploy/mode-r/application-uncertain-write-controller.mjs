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
const stage = required('ALD_MODE_R_UNCERTAIN_STAGE');
assert.ok(stage === 'inject' || stage === 'recover', `unsupported uncertain-write stage ${stage}`);
const outputRoot = required('ALD_MODE_R_OUTPUT_ROOT');
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

async function counts() {
  const [turns, channel, babyA, babyB] = await Promise.all([
    controller.port.readEvents(config.runId, 'turns'),
    controller.port.readEvents(config.runId, 'channel'),
    controller.port.readEvents(config.runId, 'baby-a-ledger'),
    controller.port.readEvents(config.runId, 'baby-b-ledger'),
  ]);
  return {
    turns: turns.length,
    channel: channel.length,
    babyALedger: babyA.length,
    babyBLedger: babyB.length,
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

async function writeResult(name, value) {
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`);
}

try {
  if (stage === 'inject') {
    const created = await runtime.createRun(config);
    const before = await counts();
    const firstError = await rejected(() => runtime.step(config.runId));
    await delay(2_000);
    const afterFirst = await counts();
    const secondError = await rejected(() => runtime.step(config.runId));
    const afterSecond = await counts();
    const summary = runtime.getRun(config.runId);
    const bundle = await runtime.exportBundle(
      config.runId, join(outputRoot, 'uncertain-bundle'));
    await writeResult('uncertain-inject-result.json', {
      schemaVersion: 1,
      classification: 'selected-application-uncertain-write-development-stage',
      researchFinding: false,
      b12Closed: false,
      stage,
      runId: config.runId,
      createdState: created.state,
      firstError,
      secondError,
      before,
      afterFirst,
      afterSecond,
      finalState: summary?.state ?? null,
      finalTurn: summary?.turn ?? null,
      operationalQuarantine: summary?.operationalQuarantine ?? null,
      bundleRunId: bundle.runId,
    });
  } else {
    const before = await counts();
    const recoveryError = await rejected(() => runtime.recover(config.runId));
    const afterRecovery = await counts();
    const stepError = await rejected(() => runtime.step(config.runId));
    const afterStep = await counts();
    const summary = runtime.getRun(config.runId);
    const bundle = await runtime.exportBundle(
      config.runId, join(outputRoot, 'recovery-refusal-bundle'));
    await writeResult('uncertain-recovery-result.json', {
      schemaVersion: 1,
      classification: 'selected-application-uncertain-write-development-stage',
      researchFinding: false,
      b12Closed: false,
      stage,
      runId: config.runId,
      recoveryError,
      stepError,
      before,
      afterRecovery,
      afterStep,
      finalState: summary?.state ?? null,
      finalTurn: summary?.turn ?? null,
      operationalQuarantine: summary?.operationalQuarantine ?? null,
      bundleRunId: bundle.runId,
    });
  }
} finally {
  await Promise.all([...factories.values()].map((factory) => factory.dispose()));
}
