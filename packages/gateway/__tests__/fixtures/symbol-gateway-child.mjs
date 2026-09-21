import { fixedTokenInventory } from '@ald/types';
import {
  connectGatewayEvidenceRpc,
  createSymbolGatewayRpcServer,
  GatewayWriteIntentJournal,
  SymbolGatewayImpl,
} from '@ald/gateway';

const [socketPath, writerSocketPath, journalDirectory, encodedConfig] =
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
process.stdout.write('ready\n');
