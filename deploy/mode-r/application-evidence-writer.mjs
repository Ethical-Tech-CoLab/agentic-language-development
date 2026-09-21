import { openEvidenceDatabase, SqliteEvidenceWriter } from '@ald/evidence';
import { connectDomainSignerRegistryRpc } from '@ald/hashing';
import { createEvidenceWriterRpcHost } from '@ald/orchestrator';
import { SIGNER_DOMAINS } from '@ald/types';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const signerRoot = required('ALD_MODE_R_SIGNER_ROOT');
const socketRoot = required('ALD_MODE_R_WRITER_SOCKET_ROOT');
const signers = await retry('domain signers', () =>
  connectDomainSignerRegistryRpc(config.runId, Object.fromEntries(
    SIGNER_DOMAINS.map((domain) => [
      domain,
      `${signerRoot}/${domain}/signer.sock`,
    ]),
  )));
const database = openEvidenceDatabase(required('ALD_MODE_R_DATABASE'));
const writer = new SqliteEvidenceWriter({
  database,
  signers,
  clock: { now: () => new Date().toISOString() },
  softwareCommit: required('ALD_SOFTWARE_COMMIT'),
});
const host = await createEvidenceWriterRpcHost(config.runId, writer, {
  controller: `${socketRoot}/controller/writer.sock`,
  gateway: `${socketRoot}/gateway/writer.sock`,
  checkpoint: `${socketRoot}/checkpoint/writer.sock`,
  anchor: `${socketRoot}/anchor/writer.sock`,
  audit: `${socketRoot}/audit/writer.sock`,
});
process.stdout.write('ready\n');
process.on('SIGTERM', async () => {
  await host.close();
  database.close();
  process.exit(0);
});
