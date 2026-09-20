import { InMemorySignerRegistry, createDomainSignerRpcServer } from '../../dist/index.js';

const [socketPath, runId, domain] = process.argv.slice(2);
if (!socketPath || !runId || !domain) throw new Error('missing signer fixture argument');
const signer = InMemorySignerRegistry.generate(runId, [domain]).signer(domain);
await createDomainSignerRpcServer(socketPath, runId, signer);
process.stdout.write('ready\n');
