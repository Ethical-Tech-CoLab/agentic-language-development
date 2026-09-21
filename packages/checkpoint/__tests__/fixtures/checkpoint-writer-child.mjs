import { EvidenceCheckpointService } from '@ald/checkpoint';
import { InMemorySignerRegistry } from '@ald/hashing';
import {
  createCheckpointEvidenceRpcServer,
  openEvidenceDatabase,
  SqliteEvidenceWriter,
} from '@ald/evidence';

const [socketPath, databasePath, encodedConfig] = process.argv.slice(2);
if (!socketPath || !databasePath || !encodedConfig) {
  throw new Error('missing checkpoint writer fixture argument');
}
const config = JSON.parse(encodedConfig);
const database = openEvidenceDatabase(databasePath);
const signers = InMemorySignerRegistry.generate(config.runId);
const clock = { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() };
const writer = new SqliteEvidenceWriter({ database, signers, clock });
writer.registerRun(config);
const service = new EvidenceCheckpointService({
  evidence: {
    readRunMetadata: writer.readRunMetadata.bind(writer),
    readCheckpoints: writer.readCheckpoints.bind(writer),
    readEvents: writer.readEvents.bind(writer),
    insertCheckpointManifest: () => {},
  },
  signers,
  clock,
  softwareCommit: 'git:checkpoint-port-fixture',
});
const manifest = await service.createCheckpoint(config.runId, 'run-initialized');
await createCheckpointEvidenceRpcServer(socketPath, config.runId, writer);
process.stdout.write(`${JSON.stringify({ manifest })}\n`);
