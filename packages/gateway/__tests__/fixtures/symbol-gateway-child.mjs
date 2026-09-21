import { fixedTokenInventory } from '@ald/types';
import {
  connectGatewayEvidenceRpc,
  createGatewayLearnerRelayServer,
  createSymbolGatewayRpcServer,
  GatewayWriteIntentJournal,
  SymbolGatewayImpl,
} from '@ald/gateway';

const [socketPath, writerSocketPath, journalDirectory, encodedConfig,
  encodedLearnerRelays] =
  process.argv.slice(2);
if (!socketPath || !writerSocketPath || !journalDirectory || !encodedConfig) {
  throw new Error('missing Gateway fixture argument');
}
const config = JSON.parse(encodedConfig);
const { port } = await connectGatewayEvidenceRpc(writerSocketPath, config.runId);
const journal = new GatewayWriteIntentJournal(journalDirectory, config.runId);
const gateway = new SymbolGatewayImpl({
  runId: config.runId,
  config,
  symbolInventory: fixedTokenInventory(config.symbolInventorySize ?? 32),
  seed: config.randomSeed,
}, await journal.openPort(port));
await createSymbolGatewayRpcServer(socketPath, gateway);
if (encodedLearnerRelays) {
  const relays = JSON.parse(encodedLearnerRelays);
  await Promise.all(['baby-a', 'baby-b'].map((role) => {
    const binding = relays[role];
    if (!binding?.socketPath || !binding?.babyHost || !binding?.babyPort) {
      throw new Error(`missing ${role} learner relay binding`);
    }
    return createGatewayLearnerRelayServer({
      socketPath: binding.socketPath,
      babyEndpoint: {
        host: binding.babyHost,
        port: binding.babyPort,
        attempts: 20,
        retryDelayMs: 50,
      },
      writer: port,
      runId: config.runId,
      role,
      babyId: role === 'baby-a' ? 'A' : 'B',
      deadlineMs: 30_000,
    });
  }));
}
process.stdout.write('ready\n');
