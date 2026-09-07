/**
 * @ald/verifier — the independent evidence-bundle verifier (ALD-015) and the
 * verification-report generator (ALD-017).
 *
 * The library depends on `@ald/types`, `@ald/hashing`, and `@ald/merkle` only:
 * it reads an exported bundle directory and never touches SQLite, the
 * orchestrator runtime, or any private key, so a third party can run it
 * against published evidence (LEDGER-INTEGRITY-DESIGN.md §14,
 * SPECIFICATION.md §4.2, docs/evidence-bundle-format.md).
 */
export {
  VERIFIER_VERSION,
  verifyBundle,
  verifyBundleDetailed,
  type DetailedVerification,
  type VerificationDetails,
  type VerifyBundleOptions,
} from './verify-bundle.js';
export {
  ALLOWED_UNANCHORED_NOTE,
  CHECK_NAMES,
  VerificationAccumulator,
  type FailOptions,
  type VerificationCheckName,
  type VerificationChecks,
} from './checks.js';
export {
  NETWORK_CHAIN_IDS,
  expectedInputData,
  verifyAnchors,
  type AnchorVerificationInput,
  type AnchorVerificationResult,
  type ChainReader,
  type ChainTransaction,
  type ChainTransactionReceipt,
} from './anchors.js';
export {
  treeNameIndex,
  verifyCheckpoints,
  verifyProofs,
  type CheckpointTree,
  type LoadedCheckpoint,
} from './checkpoints.js';
export { LINK_FIELDS, walkStream } from './chain-walk.js';
export {
  loadStreams,
  verifyCrossBindings,
  type LoadedStream,
  type LoadedStreams,
  type StreamEntry,
} from './streams.js';
export {
  verifyExperimentRecord,
  type ExperimentRecordVerification,
} from './experiment-record.js';
export {
  createJsonRpcChainReader,
  type JsonRpcChainReaderOptions,
} from './rpc.js';
export {
  USAGE,
  formatSummary,
  parseArgs,
  runCli,
  type CliIo,
  type CliOptions,
  type CliParseResult,
} from './cli.js';
export {
  formatIssues,
  listJsonFiles,
  readCanonicalJsonFile,
  readTextFile,
  stripTrailingNewline,
  type FileFailureCode,
  type FileResult,
  type SchemaIssue,
  type SchemaLike,
} from './bundle-io.js';
