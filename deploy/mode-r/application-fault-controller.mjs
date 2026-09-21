import assert from 'node:assert/strict';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
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
import { SIGNER_DOMAINS } from '@ald/types';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const faultCase = required('ALD_MODE_R_FAULT_CASE');
const outputRoot = required('ALD_MODE_R_OUTPUT_ROOT');
const triggerPath = join(outputRoot, 'fault-triggered');
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

async function writeJsonAtomic(name, value) {
  await mkdir(outputRoot, { recursive: true });
  const target = join(outputRoot, name);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, target);
}

async function waitForTrigger() {
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    try {
      await access(triggerPath);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('fault trigger did not arrive within 300000 ms');
}

async function appendDelayedAudit() {
  const ledger = await controller.port.readEvents(config.runId, 'baby-a-ledger');
  const source = ledger.find((event) => JSON.parse(event.canonicalJson).turn === 0);
  assert.ok(source, 'no eligible delayed audit source');
  return runtime.interpretAuditBatch({
    runId: config.runId,
    interpreterVersion: 'selected-application-fault-development-v1',
    entries: [{
      babyId: 'A',
      sourceEntryHash: source.entryHash,
      content: {
        term: 'development-observation',
        hypothesis: 'a killed audit interpreter rejects a subsequent audit request',
        evidence: 'bounded-development-fault-execution',
      },
    }],
  });
}

let result;
try {
  const created = await runtime.createRun(config);
  const prefix = await runtime.step(config.runId);
  const bundle = await runtime.exportBundle(config.runId, join(outputRoot, 'prefix-bundle'));
  await writeJsonAtomic('fault-ready.json', {
    schemaVersion: 1,
    runId: config.runId,
    faultCase,
    createdState: created.state,
    prefixTurn: prefix.turn,
    prefixPhase: prefix.phase,
    bundleRunId: bundle.runId,
  });
  await waitForTrigger();
  let observedError;
  try {
    if (faultCase === 'audit-interpreter-death') {
      await appendDelayedAudit();
    } else {
      await runtime.step(config.runId);
    }
  } catch (error) {
    observedError = {
      name: error instanceof Error ? error.name : 'NonErrorThrow',
      message: error instanceof Error ? error.message : String(error),
      code: typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code) : null,
      cause: error instanceof Error && error.cause instanceof Error
        ? { name: error.cause.name, message: error.cause.message }
        : null,
    };
  }
  const final = runtime.getRun(config.runId);
  result = {
    schemaVersion: 1,
    classification: 'selected-mode-r-application-fault-development-case',
    researchFinding: false,
    b12Closed: false,
    runId: config.runId,
    faultCase,
    prefixTurn: prefix.turn,
    postFaultAction: faultCase === 'audit-interpreter-death'
      ? 'interpret-audit-batch' : 'step',
    postFaultRejected: observedError !== undefined,
    observedError: observedError ?? null,
    stateAfterFault: final?.state ?? null,
    turnAfterFault: final?.turn ?? null,
    operationalQuarantine: final?.operationalQuarantine ?? null,
  };
  await writeJsonAtomic('fault-result.json', result);
  assert.equal(result.postFaultRejected, true,
    `${faultCase} post-fault action unexpectedly succeeded`);
} finally {
  await Promise.all([...factories.values()].map((factory) => factory.dispose()));
}
