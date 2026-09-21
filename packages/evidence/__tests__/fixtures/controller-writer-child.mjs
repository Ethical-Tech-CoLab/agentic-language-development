import { InMemorySignerRegistry } from '@ald/hashing';
import {
  createControllerEvidenceRpcServer,
  openEvidenceDatabase,
  SqliteEvidenceWriter,
} from '@ald/evidence';

const [socketPath, databasePath, runId] = process.argv.slice(2);
if (!socketPath || !databasePath || !runId) throw new Error('missing controller writer fixture argument');
const database = openEvidenceDatabase(databasePath);
const writer = new SqliteEvidenceWriter({
  database,
  signers: InMemorySignerRegistry.generate(runId),
});
await createControllerEvidenceRpcServer(socketPath, runId, writer);
process.stdout.write('ready\n');
