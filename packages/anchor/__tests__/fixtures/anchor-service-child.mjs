import {
  BaseAnchorPublisher,
  FakeChainTransport,
  createAnchorServiceRpcServer,
} from '@ald/anchor';
import { connectAnchorEvidenceRpc } from '@ald/evidence';

const [socketPath, writerSocket, runId] = process.argv.slice(2);
if (!socketPath || !writerSocket || !runId) {
  throw new Error('missing Anchor Service fixture argument');
}
const evidence = await connectAnchorEvidenceRpc(writerSocket, runId);
const transport = new FakeChainTransport({
  network: 'base-sepolia',
  endpointLabel: 'local-application-simulation',
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
await createAnchorServiceRpcServer(socketPath, runId, publisher);
process.stdout.write('ready\n');
