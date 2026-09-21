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
import { SIGNER_DOMAINS } from '@ald/types';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
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

try {
  await runtime.createRun(config);
  const first = await runtime.step(config.runId);
  const second = await runtime.step(config.runId);
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
  const auditEntryCount = (await controller.port.readEvents(config.runId, 'audit')).length;
  const bundle = await runtime.exportBundle(
    config.runId,
    join(outputRoot, 'bundle'),
  );
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'controller-result.json'), `${JSON.stringify({
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
  }, null, 2)}\n`);
} finally {
  await Promise.all([...factories.values()].map((factory) => factory.dispose()));
}
