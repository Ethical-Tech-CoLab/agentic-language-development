import { fixedTokenInventory } from '@ald/types';
import {
  connectGatewayEvidenceRpc,
  createGatewayLearnerRelayServer,
  createSymbolGatewayRpcServer,
  GatewayWriteIntentJournal,
  SymbolGatewayImpl,
} from '@ald/gateway';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const writerTimeoutMs = process.env.ALD_MODE_R_GATEWAY_WRITER_TIMEOUT_MS === undefined
  ? undefined : Number(process.env.ALD_MODE_R_GATEWAY_WRITER_TIMEOUT_MS);
const writer = await retry('Gateway writer', () =>
  connectGatewayEvidenceRpc(required('ALD_MODE_R_GATEWAY_WRITER'), config.runId, {
    timeoutMs: writerTimeoutMs,
  }));
const journal = new GatewayWriteIntentJournal(
  required('ALD_MODE_R_GATEWAY_JOURNAL'),
  config.runId,
);
const gateway = new SymbolGatewayImpl({
  runId: config.runId,
  config,
  symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
  seed: config.seedBindings?.gateway ?? config.randomSeed,
}, await journal.openPort(writer.port));
await createSymbolGatewayRpcServer(required('ALD_MODE_R_GATEWAY_SOCKET'), gateway);
await Promise.all(['baby-a', 'baby-b'].map((role) =>
  retry(`${role} relay`, () => createGatewayLearnerRelayServer({
    socketPath: required(role === 'baby-a'
      ? 'ALD_MODE_R_BABY_A_RELAY' : 'ALD_MODE_R_BABY_B_RELAY'),
    babyEndpoint: {
      host: role,
      port: 4318,
      attempts: 1,
      retryDelayMs: 0,
    },
    writer: writer.port,
    runId: config.runId,
    role,
    babyId: role === 'baby-a' ? 'A' : 'B',
    deadlineMs: 30_000,
  }))));
process.stdout.write('ready\n');
