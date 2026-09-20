import { InMemorySignerRegistry, createDomainSignerRpcServer } from '@ald/hashing';
import { SIGNER_DOMAINS } from '@ald/types';

const [domain, runId] = process.argv.slice(2);
if (!SIGNER_DOMAINS.includes(domain) || !/^mode-r-study-[a-z-]+$/u.test(runId ?? '')) {
  throw new Error('invalid qualification signer identity');
}

// Ephemeral qualification keys only. A selected registered run needs
// prospective per-domain Fort provisioning and recovery before execution.
const signer = InMemorySignerRegistry.generate(runId, [domain]).signer(domain);
const server = await createDomainSignerRpcServer('/signer/signer.sock', runId, signer);
process.on('SIGTERM', () => server.close());
