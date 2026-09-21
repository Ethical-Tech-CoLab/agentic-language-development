import { connectAuditEvidenceRpc } from '@ald/evidence';
import {
  AuditLedgerInterpreter,
  createAuditInterpreterRpcServer,
} from '@ald/orchestrator';

import { readJson, required, retry } from './application-common.mjs';

const config = await readJson(required('ALD_MODE_R_CONFIG'));
const evidence = await retry('audit writer', () => connectAuditEvidenceRpc(
  required('ALD_MODE_R_AUDIT_WRITER'), config.runId));
await createAuditInterpreterRpcServer(
  required('ALD_MODE_R_AUDIT_SERVICE'),
  config.runId,
  new AuditLedgerInterpreter(evidence.port),
);
process.stdout.write('ready\n');
