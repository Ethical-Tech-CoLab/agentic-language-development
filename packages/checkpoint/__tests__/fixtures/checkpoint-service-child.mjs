import { connectCheckpointEvidenceRpc } from '@ald/evidence';
import { connectDomainSignerRpc } from '@ald/hashing';
import {
  EvidenceCheckpointService,
  createCheckpointServiceRpcServer,
} from '@ald/checkpoint';

const [socketPath, writerSocket, witnessSocket, runId, softwareCommit] =
  process.argv.slice(2);
if (!socketPath || !writerSocket || !witnessSocket || !runId || !softwareCommit) {
  throw new Error('missing checkpoint service fixture argument');
}
const [evidence, witness] = await Promise.all([
  connectCheckpointEvidenceRpc(writerSocket, runId),
  connectDomainSignerRpc(witnessSocket, runId, 'witness'),
]);
const service = new EvidenceCheckpointService({
  evidence: evidence.port,
  signers: {
    runId,
    signer: (domain) => {
      if (domain !== 'witness') throw new Error('checkpoint holds only witness');
      return witness.signer;
    },
    publicKeys: () => [{
      domain: 'witness',
      keyId: witness.signer.keyId,
      publicKey: witness.signer.publicKey,
    }],
  },
  clock: { now: () => new Date().toISOString() },
  softwareCommit,
});
await createCheckpointServiceRpcServer(socketPath, runId, service);
process.stdout.write('ready\n');
