import { EvidenceCheckpointService } from '@ald/checkpoint';
import { connectDomainSignerRpc, InMemorySignerRegistry } from '@ald/hashing';
import {
  createCheckpointEvidenceRpcServer,
  openEvidenceDatabase,
  SqliteEvidenceWriter,
} from '@ald/evidence';
import { SIGNER_DOMAINS } from '@ald/types';

const [socketPath, databasePath, encodedConfig, witnessSocketPath] = process.argv.slice(2);
if (!socketPath || !databasePath || !encodedConfig) {
  throw new Error('missing checkpoint writer fixture argument');
}
const config = JSON.parse(encodedConfig);
const database = openEvidenceDatabase(databasePath);
const localSigners = InMemorySignerRegistry.generate(config.runId,
  witnessSocketPath ? SIGNER_DOMAINS.filter((domain) => domain !== 'witness') : SIGNER_DOMAINS);
const remoteWitness = witnessSocketPath
  ? (await connectDomainSignerRpc(witnessSocketPath, config.runId, 'witness')).signer
  : undefined;
const signers = remoteWitness === undefined ? localSigners : {
  runId: config.runId,
  signer: (domain) => domain === 'witness' ? remoteWitness : localSigners.signer(domain),
  publicKeys: () => [...localSigners.publicKeys(), {
    domain: 'witness', keyId: remoteWitness.keyId, publicKey: remoteWitness.publicKey,
  }],
};
const clock = { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() };
const writer = new SqliteEvidenceWriter({ database, signers, clock });
writer.registerRun(config);
await writer.appendInterventionEvent({
  runId: config.runId,
  eventType: 'annotate',
  actorId: 'checkpoint-fixture',
  reasonCode: 'remote-proof',
});
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
