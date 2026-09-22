import { InMemorySignerRegistry, createDomainSignerRpcServer } from '@ald/hashing';
import { SIGNER_DOMAINS } from '@ald/types';
import { mkdir, rename, writeFile } from 'node:fs/promises';

const [domain, runId] = process.argv.slice(2);
if (!SIGNER_DOMAINS.includes(domain) ||
    !/^(?:mode-r-(?:study|application)-[a-z0-9-]+|lv01-(?:development|recurrent-lifecycle|late-callback|five-rejection-safety)-v\d+-p\d{4}|lv01-paired-development-v\d+-p\d{4}-(?:normal|disabled|constant|random|shuffled|ledger-consistent|ledger-shuffled)|lv01-(?:commitment-window-fault|malformed-proposal)-v\d+-p\d{4}-normal)$/u.test(runId ?? '')) {
  throw new Error('invalid qualification signer identity');
}

// Ephemeral qualification keys only. A selected registered run needs
// prospective per-domain Fort provisioning and recovery before execution.
const signer = InMemorySignerRegistry.generate(runId, [domain]).signer(domain);
const socketPath = process.env['ALD_MODE_R_SIGNER_SOCKET'] ?? '/signer/signer.sock';
const publicKeyRoot = process.env['ALD_MODE_R_PUBLIC_KEYS_ROOT'];
if (publicKeyRoot !== undefined) {
  await mkdir(publicKeyRoot, { recursive: true, mode: 0o755 });
  const target = `${publicKeyRoot}/${domain}.json`;
  const temporary = `${target}.${String(process.pid)}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    domain,
    keyId: signer.keyId,
    publicKey: signer.publicKey,
  })}\n`, { mode: 0o644 });
  await rename(temporary, target);
}
const server = await createDomainSignerRpcServer(socketPath, runId, signer);
process.on('SIGTERM', () => server.close());
