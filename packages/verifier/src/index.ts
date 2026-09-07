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
  CHAIN_NOT_CHECKED_CODE,
  NETWORK_CHAIN_IDS,
  SAFE_TAG_CONFIRMATION_PROXY,
  expectedInputData,
  requiredConfirmations,
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
  type CrossBindingOptions,
  type LoadedStream,
  type LoadedStreams,
  type StreamEntry,
} from './streams.js';
export {
  REQUIRED_STREAMS,
  STREAM_FILES,
  expectedHashDomain,
  expectedSignerDomain,
  expectedTreeName,
} from './bundle-layout.js';
export {
  UNANCHORED_TX_REF,
  acceptedLearnerContractVersions,
  verifyExperimentRecord,
  type ExperimentRecordBindings,
  type ExperimentRecordVerification,
} from './experiment-record.js';
export {
  rebuildPromptBundleHash,
  verifyPromptBundle,
  type PromptBundleVerification,
} from './prompts.js';
export { describeRedacted, redactUrls, safeEndpoint } from './redact.js';
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
  bundlePath,
  containedBundlePath,
  formatIssues,
  listJsonFiles,
  readCanonicalJsonFile,
  readTextFile,
  stripTrailingNewline,
  unknownFieldDetail,
  type ContainedPath,
  type FileFailureCode,
  type FileResult,
  type PathFailureReason,
  type SchemaIssue,
  type SchemaLike,
} from './bundle-io.js';
