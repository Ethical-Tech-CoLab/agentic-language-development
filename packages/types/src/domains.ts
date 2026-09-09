/**
 * Hash domain separators, event streams, checkpoint tree names, signer
 * domains, and claim-boundary statements shared by every runtime package.
 *
 * Domains documented as "normative" come verbatim from
 * LEDGER-INTEGRITY-DESIGN.md or SPECIFICATION.md. Domains documented as
 * "implementation" are defined here because the source documents name the
 * concept (for example "the channel-event domain separator") but not the
 * separator string. Every implementation-defined domain is listed in
 * BACKLOG.md §15 (Decisions and Assumptions).
 *
 * Hash construction is always `SHA-256(domain || separatorByte || payload)`
 * and is encoded as `sha256:<64 lowercase hex>`. The separator byte is 0x00
 * unless stated otherwise (LEDGER §7 uses 0x01 for Merkle interior nodes).
 */
export const HASH_DOMAINS = {
  /** Normative, LEDGER §4: canonical unsigned ledger event → entryHash. */
  ledgerEntry: 'dtsf-baby-ledger-entry-v1',
  /** Normative, LEDGER §7: uint64BE(sequence) || entryHashBytes → leaf. */
  merkleLeaf: 'dtsf-merkle-leaf-v1',
  /** Normative, LEDGER §7: leftBytes || rightBytes → node. Separator 0x01. */
  merkleNode: 'dtsf-merkle-node-v1',
  /** Normative, LEDGER §8: canonical unsigned manifest → checkpointHash. */
  checkpoint: 'dtsf-ledger-checkpoint-v1',
  /** Normative, SPEC §9.2: carrierMode || 0x00 || canonicalArtifact → markHash. */
  carrierMark: 'dtsf-carrier-mark-v1',
  /** Normative, SPEC §14.3: canonical ordered turn tuples → replayDigest. */
  replayDigest: 'dtsf-replay-digest-v1',

  /** Implementation: canonical unsigned channel event → ChannelEvent.entryHash. */
  channelEvent: 'dtsf-channel-event-v1',
  /** Implementation: canonical unsigned affect event → AffectEvent.entryHash. */
  affectEvent: 'dtsf-affect-event-v1',
  /** Implementation: canonical unsigned generated-analysis entry → entryHash. */
  auditLedgerEntry: 'dtsf-audit-ledger-entry-v1',
  /** Implementation: canonical unsigned intervention/audit event → entryHash. */
  interventionEvent: 'dtsf-intervention-event-v1',
  /** Implementation: canonical unsigned Nursery turn record → entryHash. */
  turnRecord: 'dtsf-turn-record-v1',
  /** Implementation: canonical AgentActionProposal → babyProposalHash. */
  babyProposal: 'dtsf-baby-proposal-v1',
  /** Implementation: canonical rejected payload → rejected-payload hash. */
  rejectedPayload: 'dtsf-rejected-payload-v1',
  /** Implementation: canonical RunConfig → configurationHash / runConfigRef. */
  runConfig: 'dtsf-run-config-v1',
  /** Implementation: UTF-8 runId → runIdHash used in manifests and anchors. */
  runId: 'dtsf-run-id-v1',
  /** Implementation: canonical run manifest → run-manifest hash. */
  runManifest: 'dtsf-run-manifest-v1',
  /** Implementation: canonical pre-registration artifact → preRegistrationHash. */
  preRegistration: 'dtsf-preregistration-v1',
  /** Implementation: canonical scenario bundle config → scenarioBundleHash. */
  scenarioBundle: 'dtsf-scenario-bundle-v1',
  /** Implementation: canonical scenario ground truth + observations → stateHash. */
  scenarioState: 'dtsf-scenario-state-v1',
  /** Implementation: canonical Observation → observation hash. */
  observation: 'dtsf-observation-v1',
  /** Implementation: canonical task action proposal → actionHash. */
  action: 'dtsf-action-v1',
  /** Implementation: canonical Outcome → outcomeHash. */
  outcome: 'dtsf-outcome-v1',
  /** Implementation: concatenated learner-contract texts → promptBundleHash. */
  promptBundle: 'dtsf-prompt-bundle-v1',
  /** Implementation: canonical exported policy state → policy checkpoint hash. */
  policyCheckpoint: 'dtsf-policy-checkpoint-v1',
  /** Implementation: canonical private generative-form inventory → inventory hash. */
  carrierFormInventory: 'dtsf-carrier-form-inventory-v1',
  /** Implementation: canonical frozen unfamiliar-glyph bundle → glyphBundleHash. */
  glyphBundle: 'dtsf-glyph-bundle-v1',
  /** Implementation: canonical private affect measurement → measurement digest. */
  affectMeasurement: 'dtsf-affect-measurement-v1',
  /** Implementation: canonical retention audit entry → retention entryHash. */
  retentionLogEntry: 'dtsf-retention-log-v1',
  /** Implementation: failure message text → operator-only correlation digest. */
  failureMessage: 'dtsf-ops-failure-message-v1',
  /** Implementation: canonical causal-probe descriptor (SPEC §15.2) → probe hash. */
  causalProbe: 'dtsf-causal-probe-v1',
  /** Implementation: canonical runtime snapshot (SPEC §14.4) → snapshot digest. */
  runtimeSnapshot: 'dtsf-runtime-snapshot-v1',
  /** Implementation: E40 cipher-instance artifact (SPEC §15.4) → artifact hash. */
  encodingScheme: 'dtsf-encoding-scheme-v1',
  /** Implementation: E40 per-Baby nonce commitment → commitment hash. */
  nonceCommitment: 'dtsf-nonce-commitment-v1',
  /** Implementation: seed material for the deterministic PRNG. */
  seed: 'dtsf-seed-v1',
} as const;

export type HashDomain = (typeof HASH_DOMAINS)[keyof typeof HASH_DOMAINS];

/** Documented all-zero previous hash for the first entry of every chain (LEDGER §4). */
export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;

/**
 * Independent hash-chained event streams in the Evidence Store.
 *
 * `baby-a-ledger`, `baby-b-ledger`, and `channel` are the three mandatory
 * chains (LEDGER §6). `affect` and `audit` are the auxiliary trees named in
 * LEDGER §8. `turns` is the implementation-defined Nursery turn-record
 * stream that carries the replay-digest tuples of SPEC §14.3 and is signed
 * by the Nursery witness key. `intervention` is hash-chained and committed as
 * an auxiliary tree; the witness-signed checkpoint protects that unsigned
 * stream's exact prefix.
 */
export const EVENT_STREAMS = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'affect',
  'audit',
  'turns',
  'intervention',
] as const;

export type EventStream = (typeof EVENT_STREAMS)[number];

/** Streams whose Merkle root is mandatory in every checkpoint manifest. */
export const MANDATORY_TREES = {
  'baby-a-ledger': 'babyA',
  'baby-b-ledger': 'babyB',
  channel: 'channel',
} as const;

/** Streams committed under `auxiliaryTrees` when they contain events. */
export const AUXILIARY_TREES = {
  affect: 'affect',
  audit: 'audit',
  turns: 'turns',
  intervention: 'intervention',
} as const;

export type CheckpointTreeName =
  | (typeof MANDATORY_TREES)[keyof typeof MANDATORY_TREES]
  | (typeof AUXILIARY_TREES)[keyof typeof AUXILIARY_TREES];

/** Per-run Ed25519 signing domains (LEDGER §11). The anchor wallet is separate. */
export const SIGNER_DOMAINS = [
  'baby-a-ledger',
  'baby-b-ledger',
  'channel',
  'affect',
  'audit',
  'witness',
] as const;

export type SignerDomain = (typeof SIGNER_DOMAINS)[number];

/** Which signer domain signs each signed stream. `intervention` is unsigned. */
export const STREAM_SIGNER: Record<
  Exclude<EventStream, 'intervention'>,
  SignerDomain
> = {
  'baby-a-ledger': 'baby-a-ledger',
  'baby-b-ledger': 'baby-b-ledger',
  channel: 'channel',
  affect: 'affect',
  audit: 'audit',
  turns: 'witness',
};

/** Hash domain used for the entry hash of each stream. */
export const STREAM_HASH_DOMAIN: Record<EventStream, HashDomain> = {
  'baby-a-ledger': HASH_DOMAINS.ledgerEntry,
  'baby-b-ledger': HASH_DOMAINS.ledgerEntry,
  channel: HASH_DOMAINS.channelEvent,
  affect: HASH_DOMAINS.affectEvent,
  audit: HASH_DOMAINS.auditLedgerEntry,
  turns: HASH_DOMAINS.turnRecord,
  intervention: HASH_DOMAINS.interventionEvent,
};

/**
 * Key identifiers recorded in `writerKeyId` / `witnessKeyId`. Keys rotate per
 * run (LEDGER §11); the run manifest binds each identifier to that run's
 * public key, so the identifier itself is stable across runs.
 */
export const SIGNER_KEY_IDS: Record<SignerDomain, string> = {
  'baby-a-ledger': 'baby-a-ledger-writer-v1',
  'baby-b-ledger': 'baby-b-ledger-writer-v1',
  channel: 'channel-writer-v1',
  affect: 'affect-writer-v1',
  audit: 'audit-ledger-writer-v1',
  witness: 'nursery-witness-v1',
};

/** Fields removed from a signed event before its entry hash is recomputed. */
export const SIGNATURE_FIELDS = ['entryHash', 'writerSignature'] as const;

/** Fields removed from a signed checkpoint manifest before rehashing. */
export const MANIFEST_SIGNATURE_FIELDS = [
  'checkpointHash',
  'witnessSignature',
] as const;

/**
 * Claim-boundary sentences that MUST appear verbatim in every experiment
 * record and report (SPECIFICATION.md §5.1, §5.2, §5.4).
 */
export const CLAIM_BOUNDARY_STATEMENTS = {
  prototype:
    'This run used Prototype Mode isolation. It demonstrates protocol, ledger, ' +
    'and orchestration correctness. It does not support a channel-isolation or ' +
    'side-channel-resistance claim, because both Babies executed in the same ' +
    'process.',
  'research-grade':
    'This run used Research-Grade Mode isolation under the threat model in ' +
    '§10.3. It supports a practical side-channel-resistance claim against the ' +
    'enumerated channels. It is not a formally verified isolation proof and ' +
    'does not rule out every conceivable physical or computational side ' +
    'channel (CONCEPT-IDEA.md §10).',
} as const;

/**
 * Claim labels that describe Mode R guarantees only (SPEC §5.2, §5.3, §10.3).
 * ALD-054: a report, export, or console view of a `prototype` run that
 * carries any of these MUST be blocked with a specific error, never silently
 * downgraded.
 */
export const MODE_R_ONLY_CLAIM_LABELS = [
  'isolation-verified',
  'channel-isolation',
  'side-channel-resistance',
  'research-grade-isolation',
  'process-isolation',
  'network-route-denied',
] as const;

export type ModeROnlyClaimLabel = (typeof MODE_R_ONLY_CLAIM_LABELS)[number];

/**
 * SPEC §10.3 scope boundary that MUST be restated verbatim in any Mode R
 * publication alongside `CLAIM_BOUNDARY_STATEMENTS['research-grade']`.
 */
export const SIDE_CHANNEL_SCOPE_STATEMENT =
  'In scope (claimed): network route absence, timing/size normalization ' +
  'within the stated envelope, filesystem/process isolation, tool inventory ' +
  'audit. Explicitly out of scope (not claimed, per CONCEPT-IDEA.md §10): ' +
  'exotic hardware side channels (cache timing, power analysis), and any ' +
  'covert channel not enumerated above.';

/** Default fixed-token inventory identifiers `S01`..`S<n>` (SPEC §9.1). */
export function fixedTokenInventory(size: number): string[] {
  if (!Number.isInteger(size) || size < 2 || size > 256) {
    throw new Error('symbolInventorySize must be an integer between 2 and 256');
  }
  const width = size >= 100 ? 3 : 2;
  return Array.from({ length: size }, (_, index) =>
    `S${String(index + 1).padStart(width, '0')}`,
  );
}

/** Six-display affect identifiers (SPEC §9.3). */
export const AFFECT_DISPLAY_IDS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;
