import { BaseAnchorPublisher, FakeChainTransport } from '@ald/anchor';
import {
  openEvidenceDatabase,
  createAnchorEvidenceRpcServer,
  SqliteEvidenceWriter,
} from '@ald/evidence';
import { hashCanonical, hashRunId, InMemorySignerRegistry } from '@ald/hashing';
import { EMPTY_MERKLE_ROOT } from '@ald/merkle';
import { GENESIS_HASH, HASH_DOMAINS } from '@ald/types';

const [socketPath, databasePath, encodedConfig] = process.argv.slice(2);
if (!socketPath || !databasePath || !encodedConfig) {
  throw new Error('missing anchor writer fixture argument');
}
const config = JSON.parse(encodedConfig);
const database = openEvidenceDatabase(databasePath);
const signers = InMemorySignerRegistry.generate(config.runId);
const clock = { now: () => new Date('2026-01-01T00:00:00.000Z').toISOString() };
const writer = new SqliteEvidenceWriter({ database, signers, clock });
const { configurationHash } = writer.registerRun(config);
const emptyTree = {
  treeSize: 0,
  merkleRoot: EMPTY_MERKLE_ROOT,
  lastEntryHash: GENESIS_HASH,
};
const unsigned = {
  version: 1,
  runIdHash: hashRunId(config.runId),
  checkpointSequence: 0,
  previousCheckpointHash: GENESIS_HASH,
  babyA: emptyTree,
  babyB: emptyTree,
  channel: emptyTree,
  auxiliaryTrees: {},
  runConfigurationHash: configurationHash,
  promptBundleHash: config.promptBundleHash,
  softwareCommit: 'git:anchor-port-fixture',
  createdAt: clock.now(),
  witnessKeyId: signers.signer('witness').keyId,
  reason: 'run-initialized',
};
const checkpointHash = hashCanonical(HASH_DOMAINS.checkpoint, unsigned);
const manifest = {
  ...unsigned,
  checkpointHash,
  witnessSignature: await signers.signer('witness').sign(checkpointHash),
};
writer.insertCheckpointManifest(manifest);

const otherConfig = { ...config, runId: 'run-anchor-other' };
const otherWriter = new SqliteEvidenceWriter({
  database,
  signers: InMemorySignerRegistry.generate(otherConfig.runId),
  clock,
});
otherWriter.registerRun(otherConfig);

let preparedReceipt;
const transport = new FakeChainTransport();
const publisher = new BaseAnchorPublisher({
  transport,
  anchorClass: 'simulated',
  evidence: {
    listRuns: writer.listRuns.bind(writer),
    readCheckpoints: writer.readCheckpoints.bind(writer),
    readAnchorReceipts: writer.readAnchorReceipts.bind(writer),
    insertAnchorReceipt: (receipt) => { preparedReceipt = receipt; },
  },
  clock,
  anchorAddress: `0x${'d0'.repeat(20)}`,
  finalityPolicy: '1-confirmation',
});
const submitted = await publisher.submit(manifest);
transport.mineBlock(1);
const receipt = await publisher.awaitConfirmation(submitted);
if (preparedReceipt?.transactionHash !== receipt.transactionHash) {
  throw new Error('simulated receipt preparation failed');
}
await createAnchorEvidenceRpcServer(socketPath, config.runId, writer);
process.stdout.write(`${JSON.stringify({ receipt, allRuns: writer.listRuns() })}\n`);
