import { InMemorySignerRegistry } from '@ald/hashing';
import {
  createAuditEvidenceRpcServer,
  openEvidenceDatabase,
  SqliteEvidenceWriter,
} from '@ald/evidence';

const [socketPath, databasePath, encodedConfig] = process.argv.slice(2);
if (!socketPath || !databasePath || !encodedConfig) throw new Error('missing audit writer fixture argument');
const config = JSON.parse(encodedConfig);
const database = openEvidenceDatabase(databasePath);
const writer = new SqliteEvidenceWriter({
  database,
  signers: InMemorySignerRegistry.generate(config.runId),
});
writer.registerRun(config);
const source = await writer.appendLedgerEvent({
  runId: config.runId,
  babyId: 'A',
  turn: 0,
  draft: {
    eventType: 'intention.recorded',
    contentSchema: 'agent-native-ledger',
    subjectId: `sha256:${'d'.repeat(64)}`,
    content: { artifactRef: 'audit-port-fixture' },
    blindingNonce: 'audit-port-fixture-nonce',
    evidenceRefs: [],
  },
});
await createAuditEvidenceRpcServer(socketPath, config.runId, writer);
process.stdout.write(`${JSON.stringify({ entryHash: source.entryHash })}\n`);
