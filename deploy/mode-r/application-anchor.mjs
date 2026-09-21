import {
  BaseAnchorPublisher,
  FakeChainTransport,
  createAnchorServiceRpcServer,
} from '@ald/anchor';
import { connectAnchorEvidenceRpc } from '@ald/evidence';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const evidence = await retry('anchor writer', () => connectAnchorEvidenceRpc(
  required('ALD_MODE_R_ANCHOR_WRITER'), config.runId));
const transport = new FakeChainTransport({
  network: 'base-sepolia',
  endpointLabel: 'selected-application-local-simulation',
});
const publisher = new BaseAnchorPublisher({
  transport,
  anchorClass: 'simulated',
  evidence: evidence.port,
  clock: { now: () => new Date().toISOString() },
  anchorAddress: `0x${'42'.repeat(20)}`,
  finalityPolicy: '1-confirmation',
  retry: {
    attempts: 2,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
    sleep: async () => { transport.mineBlock(); },
  },
  confirmationPoll: { attempts: 2, intervalMs: 0 },
});
await createAnchorServiceRpcServer(
  required('ALD_MODE_R_ANCHOR_SERVICE'),
  config.runId,
  publisher,
);
process.stdout.write('ready\n');
