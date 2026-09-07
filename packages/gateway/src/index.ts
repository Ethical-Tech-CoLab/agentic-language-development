/**
 * `@ald/gateway` — the Symbol Gateway: the single mediation point for every
 * inter-agent artifact (SPECIFICATION.md §4.1 item 3, §9).
 *
 * There is no route from one Baby to the other. A proposal is validated
 * against the run's registered protocol module, transformed by the §9.6
 * communication-control condition, committed atomically through the one
 * Evidence Writer, and only then released to the receiver. Every rejection is
 * itself evidence and carries a reason code and a payload hash, never the
 * attempted content.
 *
 * Owning backlog items: ALD-029 (core router), ALD-030 (fixed-token
 * protocol), ALD-034 (rejection framework), ALD-035 (boundary schemas),
 * ALD-036 (conformance suite).
 */
export {
  ABSOLUTE_MAX_SYMBOLS_PER_MESSAGE,
  carrierModule,
  DEFAULT_MAX_SYMBOL_REPEATS,
  DEFAULT_MAX_SYMBOLS_PER_MESSAGE,
  fixedTokenModule,
  maxSymbolsFor,
  registerCarrierModule,
  registeredCarriers,
  resetCarrierModules,
  type ActionKind,
  type CarrierContext,
  type CarrierModule,
  type CarrierValidationResult,
  type PublicArtifact,
} from './carrier-modules.js';
export {
  ControlArtifactNotPermittedError,
  GatewayError,
  InterpretationRejectedError,
  InvalidControlArtifactError,
  InvalidSymbolInventoryError,
  isGatewayError,
  OracleRequiresControlArtifactError,
  ShuffledBatchRequiredError,
  toGatewayError,
  toGatewayRejectionResponse,
  TurnDeadlineExceededError,
  UnsupportedCarrierError,
  type GatewayErrorBody,
  type GatewayErrorCode,
  type GatewayErrorResponse,
  type GatewayErrorStatus,
} from './errors.js';
export {
  DEFAULT_COMPLEXITY_BUDGET,
  findTrustedMetadataKey,
  isWithinComplexityBudget,
  PayloadTooComplexError,
  TRUSTED_METADATA_KEYS,
  type ComplexityBudget,
  type TrustedMetadataKey,
} from './inspect.js';
export {
  GATEWAY_REASON_CODES,
  isGatewayReasonCode,
  type GatewayReasonCode,
} from './reason-codes.js';
export {
  GATEWAY_ACTOR_ID,
  MAX_CONSECUTIVE_REJECTIONS_REASON,
  SymbolGatewayImpl,
  withTurnDeadline,
  type GatewayDelivery,
  type GatewayRejection,
  type SymbolGatewayOptions,
} from './symbol-gateway.js';
export {
  assertEveryCarrierHasVectors,
  conformanceVectorsFor,
  registerConformanceVectors,
  resetConformanceVectors,
  CONFORMANCE_INVENTORY,
  CONFORMANCE_MAX_SYMBOL_REPEATS,
  CONFORMANCE_MAX_SYMBOLS,
  conformanceIntentionDraft,
  FIXED_TOKEN_VECTORS,
  type ConformanceVector,
} from './conformance-vectors.js';
export {
  InMemoryEvidenceError,
  InMemoryEvidenceWriter,
  REQUIRED_SIGNER_DOMAINS,
  StepClock,
  type InMemoryEvidenceWriterOptions,
} from './testing.js';
