import { connectAuditEvidenceRpc } from '@ald/evidence';
import {
  AuditLedgerInterpreter,
  createAuditInterpreterRpcServer,
} from '@ald/orchestrator';

const [socketPath, writerSocket, runId] = process.argv.slice(2);
if (!socketPath || !writerSocket || !runId) {
  throw new Error('missing Audit Interpreter fixture argument');
}
const evidence = await connectAuditEvidenceRpc(writerSocket, runId);
const interpreter = new AuditLedgerInterpreter(evidence.port);
await createAuditInterpreterRpcServer(socketPath, runId, interpreter);
process.stdout.write('ready\n');
