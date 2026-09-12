/**
 * Runtime-validated schemas for the evidence integrity chain: checkpoint
 * manifests (LEDGER §8), run manifests (LEDGER §13 bundle), anchor receipts
 * (LEDGER §10), Merkle proofs (LEDGER §7), and the implementation-defined
 * turn-record, intervention, and generated-analysis streams.
 *
 * All hashes here use the strict `sha256:<hex>` encoding; all signatures use
 * `ed25519:<base64>`; all public keys use `ed25519-pub:<base64>`.
 */
import { z } from 'zod';

import { MODE_R_ONLY_CLAIM_LABELS } from './domains.js';

const strictHash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ed25519Signature = z.string().regex(/^ed25519:[A-Za-z0-9+/]+=*$/u);
const ed25519PublicKey = z.string().regex(/^ed25519-pub:[A-Za-z0-9+/]+=*$/u);
const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const isoDateTime = z.iso.datetime({ offset: true });
const evmHash = z.string().regex(/^0x[a-f0-9]{64}$/iu);
const evmAddress = z.string().regex(/^0x[a-f0-9]{40}$/iu);

export const TreeReferenceSchema = z.object({
  treeSize: nonNegativeInteger,
  merkleRoot: strictHash,
  lastEntryHash: strictHash,
});

export const CheckpointReasonSchema = z.enum([
  'run-initialized',
  'event-interval',
  'time-interval',
  'policy-checkpoint',
  'analysis',
  'intervention',
  'pause',
  'recovery',
  'run-sealed',
  'run-aborted',
]);

/**
 * LEDGER §8 manifest before hashing and witness signature. `auxiliaryTrees`
 * is always present (possibly empty) so canonical form is deterministic.
 * `reason` is an implementation extension recording the LEDGER §9 trigger.
 */
export const UnsignedCheckpointManifestSchema = z.object({
  version: z.literal(1),
  runIdHash: strictHash,
  checkpointSequence: nonNegativeInteger,
  previousCheckpointHash: strictHash,
  babyA: TreeReferenceSchema,
  babyB: TreeReferenceSchema,
  channel: TreeReferenceSchema,
  auxiliaryTrees: z.record(z.string(), TreeReferenceSchema),
  runConfigurationHash: strictHash,
  promptBundleHash: strictHash,
  softwareCommit: nonEmptyString,
  createdAt: isoDateTime,
  witnessKeyId: nonEmptyString,
  reason: CheckpointReasonSchema,
});

export const CheckpointManifestSchema = UnsignedCheckpointManifestSchema.extend({
  checkpointHash: strictHash,
  witnessSignature: ed25519Signature,
});

export const SignerPublicKeyRecordSchema = z.object({
  domain: z.enum([
    'baby-a-ledger',
    'baby-b-ledger',
    'channel',
    'affect',
    'audit',
    'witness',
  ]),
  keyId: nonEmptyString,
  publicKey: ed25519PublicKey,
});

export const StreamDeclarationSchema = z.object({
  stream: z.enum([
    'baby-a-ledger',
    'baby-b-ledger',
    'channel',
    'affect',
    'audit',
    'turns',
    'intervention',
  ]),
  file: nonEmptyString,
  hashDomain: nonEmptyString,
  signerDomain: SignerPublicKeyRecordSchema.shape.domain.optional(),
  treeName: z.string().min(1).optional(),
});

/** `run-manifest.json` at the root of an exported evidence bundle. */
/**
 * The canonical pre-registration artifact (SPEC §15.1): hashed with
 * `HASH_DOMAINS.preRegistration` into `RunConfig.preRegistrationHash`.
 * `parameters` is the complete registered run-configuration template and
 * factor matrix minus realized run IDs, random seeds, condition assignments,
 * and `preRegistrationHash` itself; `seeds` lists the pre-registered seed
 * labels. This permits one study artifact to bind every condition in a
 * pre-registered matrix without making per-run identity part of the study
 * hypothesis.
 */
export const PreRegistrationArtifactSchema = z.object({
  version: z.literal(1),
  experimentId: z.string().regex(/^E\d{2}$/u),
  protocolGitCommit: nonEmptyString,
  registrationClass: z.enum(['qualification', 'confirmatory']),
  hypothesis: nonEmptyString,
  parameters: z.record(z.string(), z.unknown()),
  seeds: z.array(nonEmptyString).min(1),
  analysisPlan: nonEmptyString,
});

/**
 * How a run's pre-registration was bound (SPEC §15.1; ALD-071). Recorded in
 * the run manifest. A `confirmatory` binding MUST carry the external
 * registration and a confirmed pre-run commitment of `preRegistrationHash`,
 * including its simulated/public receipt class; a `qualification` binding is
 * labeled non-confirmatory.
 */
export const PreRegistrationBindingSchema = z.object({
  registrationClass: z.enum(['qualification', 'confirmatory']),
  preRegistrationHash: strictHash,
  externalRegistrationUrl: z.string().url().optional(),
  externalRegistrationId: nonEmptyString.optional(),
  registeredAt: isoDateTime.optional(),
  preRunAnchor: z
    .object({
      anchorClass: z.enum(['simulated', 'public-chain']),
      network: z.enum(['base-sepolia', 'base-mainnet']),
      chainId: positiveInteger,
      transactionHash: evmHash,
      inputData: z.string().regex(/^0x[a-f0-9]*$/iu),
      blockNumber: nonNegativeInteger.nullable(),
      status: z.enum(['submitted', 'confirmed', 'failed']),
    })
    .optional(),
  /** Verbatim non-confirmatory label for qualification bindings. */
  label: nonEmptyString,
});

export const RunManifestSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  runIdHash: strictHash,
  experimentId: z.string().regex(/^E\d{2}$/u),
  deploymentMode: z.enum(['prototype', 'research-grade']),
  claimBoundaryStatement: nonEmptyString,
  claimLabels: z.enum(MODE_R_ONLY_CLAIM_LABELS).array().optional(),
  configurationHash: strictHash,
  scenarioBundleHash: strictHash,
  promptBundleHash: strictHash,
  protocolGitCommit: nonEmptyString,
  preRegistrationHash: strictHash,
  softwareCommit: nonEmptyString,
  createdAt: isoDateTime,
  parentRunId: nonEmptyString.optional(),
  derivedFromCheckpointHash: strictHash.optional(),
  initialPolicyRefs: z
    .object({
      babyA: nonEmptyString,
      babyB: nonEmptyString,
    })
    .optional(),
  learnerContractVersions: z.object({
    babyA: nonEmptyString,
    babyB: nonEmptyString,
  }),
  signers: z.array(SignerPublicKeyRecordSchema).min(1),
  streams: z.array(StreamDeclarationSchema).min(3),
  /** SPEC §15.1 binding; absent on runs created before ALD-071 completed. */
  preRegistration: PreRegistrationBindingSchema.optional(),
});

/** Full anchor receipt persisted in `anchor_receipts` and `anchors/`. */
export const AnchorReceiptSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  checkpointSequence: nonNegativeInteger,
  checkpointHash: strictHash,
  anchorClass: z.enum(['simulated', 'public-chain']),
  network: z.enum(['base-sepolia', 'base-mainnet']),
  chainId: positiveInteger,
  transactionHash: evmHash,
  from: evmAddress,
  to: evmAddress,
  inputData: z.string().regex(/^0x[a-f0-9]*$/iu),
  blockNumber: nonNegativeInteger.nullable(),
  blockHash: evmHash.nullable(),
  status: z.enum(['submitted', 'confirmed', 'failed']),
  confirmations: nonNegativeInteger,
  finalityPolicy: nonEmptyString,
  rpcEndpointLabel: nonEmptyString,
  recordedAt: isoDateTime,
});

export const InclusionProofSchema = z.object({
  version: z.literal(1),
  stream: StreamDeclarationSchema.shape.stream,
  treeName: nonEmptyString,
  checkpointSequence: nonNegativeInteger,
  treeSize: positiveInteger,
  leafIndex: nonNegativeInteger,
  sequence: positiveInteger,
  entryHash: strictHash,
  leafHash: strictHash,
  path: z.array(strictHash),
  root: strictHash,
});

export const ConsistencyProofSchema = z.object({
  version: z.literal(1),
  stream: StreamDeclarationSchema.shape.stream,
  treeName: nonEmptyString,
  fromCheckpointSequence: nonNegativeInteger,
  toCheckpointSequence: nonNegativeInteger,
  fromSize: nonNegativeInteger,
  toSize: nonNegativeInteger,
  fromRoot: strictHash,
  toRoot: strictHash,
  path: z.array(strictHash),
});

/**
 * Nursery-owned per-turn record (implementation stream `turns`). Carries the
 * SPEC §14.3 replay-digest tuple plus researcher-only outcome detail. Signed
 * by the Nursery witness key. Never delivered to a Baby.
 */
export const UnsignedTurnRecordSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  sequence: positiveInteger,
  turn: nonNegativeInteger,
  phase: z.enum(['running', 'evaluating']),
  roles: z.object({
    sender: z.enum(['baby-a', 'baby-b']),
    receiver: z.enum(['baby-a', 'baby-b']),
  }),
  communicationCondition: z.enum([
    'normal',
    'disabled',
    'constant',
    'random',
    'shuffled',
    'oracle',
  ]),
  scenarioRef: nonEmptyString,
  scenarioStateHash: strictHash,
  observationHashes: z.object({ babyA: strictHash, babyB: strictHash }),
  /**
   * Set on turns that belong to a frozen evaluation block inside `running`
   * (E31 drift evaluation) or a held-out evaluation (E15); absent otherwise.
   */
  evaluationBlock: z
    .object({
      kind: z.enum(['drift', 'held-out']),
      index: nonNegativeInteger,
    })
    .optional(),
  /** E14 bounded second attempt on the same scenario episode. */
  repairAttempt: z
    .object({
      episodeId: nonEmptyString,
      attempt: z.literal(1),
      originalTurn: nonNegativeInteger,
    })
    .optional(),
  /** SPEC §15.2: hash of the live causal probe applied to this turn's delivery. */
  probeHash: strictHash.optional(),
  babyProposalHash: strictHash.nullable(),
  deliveredArtifactHash: strictHash,
  channelEventHash: strictHash.nullable(),
  actionHash: strictHash,
  outcomeHash: strictHash,
  outcome: z.record(z.string(), z.unknown()),
  previousEntryHash: strictHash,
  recordedAt: isoDateTime,
  writerKeyId: nonEmptyString,
});

export const TurnRecordSchema = UnsignedTurnRecordSchema.extend({
  entryHash: strictHash,
  writerSignature: ed25519Signature,
});

export const InterventionEventTypeSchema = z.enum([
  'pause',
  'resume',
  'abort',
  'annotate',
  'safety-trigger',
  'human-view',
  'recovery',
  'governance-decision',
  'hygiene-block',
  /** Runtime-recorded facts about the run: isolation descriptors, provenance, initial policy hashes. */
  'runtime-attestation',
  /** The ledger-derived live-probe schedule frozen before evaluation begins. */
  'probe-schedule',
  /** E16 baseline/native predictions committed after delivery and before receiver action. */
  'prediction-commitment',
  /** An E14 bounded second attempt was scheduled after a failed episode. */
  'repair-turn',
  /** SPEC §15.2 live probe applied to one delivery (details carry the probe hash). */
  'causal-probe',
  /** E22 pre-registered stage applied (details carry policy hashes before/after). */
  'curriculum-transition',
  /** An `analysis/` attachment was produced during the run (details carry its sha256). */
  'analysis-attached',
  /** SPEC §14.6 retention job action (bulk payload purge; index rows retained). */
  'retention-purge',
]);

/**
 * Append-only `intervention_log` row (SPEC §14.2, §14.5). Entries are
 * hash-chained and unsigned; checkpoint manifests witness their Merkle prefix.
 */
export const UnsignedInterventionEventSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  sequence: positiveInteger,
  eventType: InterventionEventTypeSchema,
  actorId: nonEmptyString,
  reasonCode: nonEmptyString,
  details: z.record(z.string(), z.unknown()),
  previousEntryHash: strictHash,
  recordedAt: isoDateTime,
});

export const InterventionEventSchema = UnsignedInterventionEventSchema.extend({
  entryHash: strictHash,
});

/** Append-only generated-analysis interpretation (SPEC §13.6). */
export const UnsignedAuditLedgerEntrySchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  sequence: positiveInteger,
  babyId: z.enum(['A', 'B']),
  source: z.literal('generated-analysis'),
  sourceEntryHash: strictHash,
  interpreterVersion: nonEmptyString,
  content: z.object({
    term: nonEmptyString,
    hypothesis: nonEmptyString,
    confidence: z.number().min(0).max(1).optional(),
    evidence: nonEmptyString,
  }),
  previousEntryHash: strictHash,
  recordedAt: isoDateTime,
  writerKeyId: nonEmptyString,
});

export const AuditLedgerEntrySchema = UnsignedAuditLedgerEntrySchema.extend({
  entryHash: strictHash,
  writerSignature: ed25519Signature,
});

/**
 * One analysis artifact stored under `analysis/` in a bundle
 * (docs/evidence-bundle-format.md §10). `sha256` is the plain SHA-256 of the
 * file bytes (`sha256:<hex>`, no domain — the file is a public artifact a
 * third party hashes with any tool). `boundBy` names the chained evidence
 * entry that carries the same hash when the artifact was produced during the
 * run; an unbound attachment is post-run analysis and is reported as such.
 */
export const BundleAttachmentSchema = z.object({
  path: z
    .string()
    .regex(/^analysis\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/u),
  sha256: strictHash,
  kind: z.enum([
    'intervention-suite',
    'semantic-leakage-battery',
    'side-channel-audit',
    'red-team-observation',
    'carrier-leakage',
    'affect-leakage',
    'encoding-events',
    'curriculum-transitions',
    'drift-evaluation',
    'replay-check',
    'causal-prediction',
    'other',
  ]),
  analysisVersion: nonEmptyString,
  producedAt: isoDateTime,
  boundBy: z
    .object({
      stream: z.enum(['audit', 'intervention', 'turns']),
      entryHash: strictHash,
    })
    .optional(),
});

/** `analysis/index.json`: every attachment the bundle carries. */
export const BundleAttachmentIndexSchema = z.object({
  version: z.literal(1),
  runId: nonEmptyString,
  attachments: z.array(BundleAttachmentSchema),
});

/** `experiment-record.json`: current record plus full append-only history. */
export const ExperimentRecordFileSchema = z.object({
  current: z.record(z.string(), z.unknown()),
  history: z.array(z.record(z.string(), z.unknown())).min(1),
});

export type TreeReference = z.infer<typeof TreeReferenceSchema>;
export type CheckpointReason = z.infer<typeof CheckpointReasonSchema>;
export type UnsignedCheckpointManifest = z.infer<
  typeof UnsignedCheckpointManifestSchema
>;
export type CheckpointManifest = z.infer<typeof CheckpointManifestSchema>;
export type SignerPublicKeyRecord = z.infer<typeof SignerPublicKeyRecordSchema>;
export type StreamDeclaration = z.infer<typeof StreamDeclarationSchema>;
export type RunManifest = z.infer<typeof RunManifestSchema>;
export type AnchorReceipt = z.infer<typeof AnchorReceiptSchema>;
export type InclusionProof = z.infer<typeof InclusionProofSchema>;
export type ConsistencyProof = z.infer<typeof ConsistencyProofSchema>;
export type UnsignedTurnRecord = z.infer<typeof UnsignedTurnRecordSchema>;
export type TurnRecord = z.infer<typeof TurnRecordSchema>;
export type InterventionEventType = z.infer<typeof InterventionEventTypeSchema>;
export type UnsignedInterventionEvent = z.infer<
  typeof UnsignedInterventionEventSchema
>;
export type InterventionEvent = z.infer<typeof InterventionEventSchema>;
export type UnsignedAuditLedgerEntry = z.infer<
  typeof UnsignedAuditLedgerEntrySchema
>;
export type AuditLedgerEntry = z.infer<typeof AuditLedgerEntrySchema>;
export type ExperimentRecordFile = z.infer<typeof ExperimentRecordFileSchema>;
export type PreRegistrationArtifact = z.infer<typeof PreRegistrationArtifactSchema>;
export type PreRegistrationBinding = z.infer<typeof PreRegistrationBindingSchema>;
export type BundleAttachment = z.infer<typeof BundleAttachmentSchema>;
export type BundleAttachmentIndex = z.infer<typeof BundleAttachmentIndexSchema>;
