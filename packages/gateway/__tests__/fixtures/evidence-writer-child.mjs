import { InMemorySignerRegistry } from '@ald/hashing';
import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { createGatewayEvidenceRpcServer } from '@ald/gateway';

const [socketPath, databasePath, encodedConfig] = process.argv.slice(2);
if (!socketPath || !databasePath || !encodedConfig) throw new Error('missing writer fixture argument');
const config = JSON.parse(encodedConfig);
const database = openEvidenceDatabase(databasePath);
const writer = new SqliteEvidenceWriter({
  database,
  signers: InMemorySignerRegistry.generate(config.runId),
});
writer.registerRun(config);
await createGatewayEvidenceRpcServer(socketPath, config.runId, writer);
process.stdout.write('ready\n');
