import { connectCheckpointEvidenceRpc } from '@ald/evidence';
import { connectDomainSignerRpc } from '@ald/hashing';
import {
  EvidenceCheckpointService,
  createCheckpointServiceRpcServer,
} from '@ald/checkpoint';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const [evidence, witness] = await Promise.all([
  retry('checkpoint writer', () => connectCheckpointEvidenceRpc(
    required('ALD_MODE_R_CHECKPOINT_WRITER'), config.runId)),
  retry('witness signer', () => connectDomainSignerRpc(
    required('ALD_MODE_R_WITNESS_SIGNER'), config.runId, 'witness')),
]);
const service = new EvidenceCheckpointService({
  evidence: evidence.port,
  signers: {
    runId: config.runId,
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
  softwareCommit: required('ALD_SOFTWARE_COMMIT'),
});
await createCheckpointServiceRpcServer(
  required('ALD_MODE_R_CHECKPOINT_SERVICE'),
  config.runId,
  service,
);
process.stdout.write('ready\n');
