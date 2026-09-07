/**
 * `@ald/anchor` — Base anchoring for checkpoint manifests
 * (LEDGER-INTEGRITY-DESIGN.md §10–§12, SPECIFICATION.md §11.8, §13.4, §13.5).
 *
 * Only the 32-byte checkpoint digest is ever written on chain. A checkpoint
 * manifest goes in, a zero-value transaction from a dedicated low-balance
 * wallet goes out, and an Anchor Receipt — one per chain per checkpoint —
 * comes back and is stored exactly once, at a terminal decision, in the
 * append-only evidence store.
 *
 * Owning backlog items: ALD-018 (receipt storage), ALD-019 (anchor key
 * management, separate from every event/witness key), ALD-020 (Base Sepolia
 * client, the unconditional default), ALD-021 (confirmation, retry/backoff,
 * and the verifier's chain-read half), ALD-022 (mainnet opt-in switch, off
 * unless both the option and the environment variable are set).
 */
export {
  AnchorError,
  AnchorKeyFileError,
  AnchorNetworkMismatchError,
  AnchorPayloadMismatchError,
  AnchorSubmissionFailedError,
  InvalidFinalityPolicyError,
  MainnetAnchoringDisabledError,
  PendingFileInvalidError,
  TransientChainError,
  UnknownAnchorCheckpointError,
  UnknownAnchorRunError,
  isAnchorError,
  type AnchorErrorCode,
} from './errors.js';
export {
  ANCHOR_CHAIN_IDS,
  ANCHOR_INPUT_DATA_LENGTH,
  anchorInputData,
  type AnchorNetwork,
  type AnchorTransactionInput,
  type ChainReader,
  type ChainTransaction,
  type ChainTransactionReceipt,
  type ChainTransport,
  type SentAnchorTransaction,
} from './transport.js';
export {
  DEFAULT_FAKE_FROM_ADDRESS,
  FakeChainTransport,
  type FakeChainTransportOptions,
} from './fake-transport.js';
export {
  ViemChainTransport,
  type ViemChainTransportOptions,
} from './viem-transport.js';
export {
  ANCHOR_KEY_FILE_MODE,
  FORBIDDEN_KEY_FILE_MODE_BITS,
  generateAnchorKey,
  loadAnchorKeyFile,
  writeAnchorKeyFile,
  type AnchorKey,
  type HexString,
  type LoadAnchorKeyFileOptions,
} from './key-file.js';
export {
  PendingAnchorFileSchema,
  PendingAnchorSubmissionSchema,
  addPendingSubmission,
  findPendingSubmission,
  readPendingSubmissions,
  removePendingSubmission,
  writePendingSubmissions,
  type PendingAnchorSubmission,
} from './pending.js';
export {
  BaseAnchorPublisher,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RETRY_ATTEMPTS,
  MAINNET_ANCHORING_ENV_VAR,
  SAFE_TAG_CONFIRMATION_PROXY,
  requiredConfirmations,
  type AnchorEvidenceStore,
  type AnchorRetryOptions,
  type BaseAnchorPublisherOptions,
} from './publisher.js';
export {
  expectedChainId,
  verifyAnchorReceipt,
  type AnchorVerificationChecks,
  type AnchorVerificationResult,
} from './verify-anchor.js';
