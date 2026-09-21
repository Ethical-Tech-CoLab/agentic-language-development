import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { connectDomainSignerRpc, InMemorySignerRegistry } from '@ald/hashing';
import { createEvidenceWriterRpcHost } from '@ald/orchestrator';
import { SIGNER_DOMAINS } from '@ald/types';

const [databasePath, encodedConfig, encodedSockets, witnessSocketPath] = process.argv.slice(2);
if (!databasePath || !encodedConfig || !encodedSockets || !witnessSocketPath) {
  throw new Error('missing evidence writer host fixture argument');
}
const config = JSON.parse(encodedConfig);
const sockets = JSON.parse(encodedSockets);
const local = InMemorySignerRegistry.generate(config.runId,
  SIGNER_DOMAINS.filter((domain) => domain !== 'witness'));
const witness = (await connectDomainSignerRpc(
  witnessSocketPath, config.runId, 'witness')).signer;
const signers = {
  runId: config.runId,
  signer: (domain) => domain === 'witness' ? witness : local.signer(domain),
  publicKeys: () => [...local.publicKeys(), {
    domain: 'witness', keyId: witness.keyId, publicKey: witness.publicKey,
  }],
};
const database = openEvidenceDatabase(databasePath);
const writer = new SqliteEvidenceWriter({
  database,
  signers,
  clock: { now: () => new Date().toISOString() },
  softwareCommit: 'git:evidence-writer-host-fixture',
});
await createEvidenceWriterRpcHost(config.runId, writer, sockets);
process.stdout.write(`${JSON.stringify({
  processId: process.pid,
  publicKeys: signers.publicKeys(),
})}\n`);
