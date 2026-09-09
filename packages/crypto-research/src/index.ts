/**
 * E40 ephemeral-encoding research instrumentation (ALD-069/070).
 *
 * This package records scheme changes and eavesdropper attempts over synthetic
 * messages. It deliberately provides no encryption API and always reports
 * cryptographic security as `not-established`.
 */
import {
  canonicalJson,
  encodeHash,
  hashCanonical,
  sha256Bytes,
} from '@ald/hashing';
import { HASH_DOMAINS, type Clock, type Sha256Hash } from '@ald/types';

export const PACKAGE_NAME = '@ald/crypto-research';
export const ENCODING_HARNESS_VERSION = 'ephemeral-encoding-harness-v1';
export const CRYPTOGRAPHIC_SECURITY_STATUS = 'not-established' as const;
export const RESEARCH_ONLY_NOTICE =
  'Research instrumentation only. Novelty and adversarial recovery measurements do not establish cryptographic security.';

export const ENCODING_ROLES = [
  'baby-a',
  'baby-b',
  'eavesdropper',
] as const;
export type EncodingRole = (typeof ENCODING_ROLES)[number];
export type CommunicatingRole = Exclude<EncodingRole, 'eavesdropper'>;
export type CipherThreatModel =
  | 'post-run-disclosure'
  | 'external-observer-only'
  | 'novelty-only';
export type GenerativeCarrier =
  | 'generative-bitmap'
  | 'generative-canvas'
  | 'generative-tone';

export interface NonceCommitment {
  role: CommunicatingRole;
  commitmentHash: Sha256Hash;
  committedAt: string;
}

export interface EncodingSchemeEvent {
  version: 1;
  runId: string;
  sequence: number;
  schemeId: Sha256Hash;
  artifactHash: Sha256Hash;
  proposedBy: CommunicatingRole;
  carrierMode: GenerativeCarrier;
  nonceCommitments: Record<CommunicatingRole, Sha256Hash>;
  publicSaltHash: Sha256Hash;
  previousEventHash: Sha256Hash;
  eventHash: Sha256Hash;
  changedAt: string;
}

export interface EavesdropperAttempt {
  version: 1;
  runId: string;
  sequence: number;
  role: 'eavesdropper';
  schemeId: Sha256Hash;
  adversaryId: string;
  architectureClass: 'history-trained' | 'training-time' | 'unseen';
  messageIdHash: Sha256Hash;
  guessHash: Sha256Hash;
  recovered: boolean;
  attemptedAt: string;
}

export interface EncodingHarnessReport {
  kind: 'encoding-events';
  analysisVersion: typeof ENCODING_HARNESS_VERSION;
  runId: string;
  participants: readonly EncodingRole[];
  carrierMode: GenerativeCarrier;
  cipherThreatModel: CipherThreatModel;
  syntheticMessagesOnly: true;
  nonceCommitments: NonceCommitment[];
  schemeEvents: EncodingSchemeEvent[];
  eavesdropperAttempts: EavesdropperAttempt[];
  uniqueArtifactCount: number;
  priorRegistryCollisions: Sha256Hash[];
  cryptographicSecurity: typeof CRYPTOGRAPHIC_SECURITY_STATUS;
  researchOnlyNotice: typeof RESEARCH_ONLY_NOTICE;
}

export interface EphemeralEncodingHarnessOptions {
  runId: string;
  carrierMode: GenerativeCarrier;
  cipherThreatModel: CipherThreatModel;
  syntheticMessagesOnly: true;
  clock: Clock;
  /** Artifact hashes observed before this run; novelty comparison only. */
  priorArtifactHashes?: Iterable<Sha256Hash>;
}

export interface RegisterSchemeInput {
  proposedBy: CommunicatingRole;
  /** Canonicalizable public description; never a production secret or key. */
  canonicalProtocolArtifact: unknown;
  publicSalt: string;
}

export interface RecordEavesdropperAttemptInput {
  schemeId: Sha256Hash;
  adversaryId: string;
  architectureClass: EavesdropperAttempt['architectureClass'];
  messageId: string;
  guess: unknown;
  actual: unknown;
}

const GENESIS_EVENT_HASH = `sha256:${'0'.repeat(64)}`;

function assertNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty`);
  }
}

function plainTextHash(value: string): Sha256Hash {
  return encodeHash(sha256Bytes(Buffer.from(value, 'utf8')));
}

/** Append-only, one-run E40 measurement harness. */
export class EphemeralEncodingHarness {
  readonly participants = ENCODING_ROLES;

  private readonly commitments = new Map<CommunicatingRole, NonceCommitment>();
  private readonly schemes: EncodingSchemeEvent[] = [];
  private readonly attempts: EavesdropperAttempt[] = [];
  private readonly priorArtifacts: Set<Sha256Hash>;

  constructor(private readonly options: EphemeralEncodingHarnessOptions) {
    assertNonEmpty('runId', options.runId);
    if (options.syntheticMessagesOnly !== true) {
      throw new Error('E40 harness accepts synthetic messages only');
    }
    this.priorArtifacts = new Set(options.priorArtifactHashes ?? []);
  }

  /** Commit a nonce contribution without retaining or exposing the nonce. */
  commitNonce(role: CommunicatingRole, nonce: string): NonceCommitment {
    assertNonEmpty('nonce', nonce);
    if (this.commitments.has(role)) {
      throw new Error(`${role} already committed a nonce`);
    }
    const commitment: NonceCommitment = {
      role,
      commitmentHash: hashCanonical(HASH_DOMAINS.nonceCommitment, {
        runId: this.options.runId,
        role,
        nonce,
      }),
      committedAt: this.options.clock.now(),
    };
    this.commitments.set(role, commitment);
    return commitment;
  }

  /** Record one distinct scheme change after both nonce commitments exist. */
  registerScheme(input: RegisterSchemeInput): EncodingSchemeEvent {
    assertNonEmpty('publicSalt', input.publicSalt);
    const babyA = this.commitments.get('baby-a');
    const babyB = this.commitments.get('baby-b');
    if (babyA === undefined || babyB === undefined) {
      throw new Error('both Baby nonce commitments are required before a scheme');
    }
    canonicalJson(input.canonicalProtocolArtifact);
    const artifactHash = hashCanonical(HASH_DOMAINS.encodingScheme, {
      runId: this.options.runId,
      carrierMode: this.options.carrierMode,
      nonceCommitments: {
        'baby-a': babyA.commitmentHash,
        'baby-b': babyB.commitmentHash,
      },
      publicSalt: input.publicSalt,
      protocolArtifact: input.canonicalProtocolArtifact,
    });
    if (this.schemes.some((event) => event.artifactHash === artifactHash)) {
      throw new Error(`scheme ${artifactHash} is already registered in this run`);
    }
    const unsigned = {
      version: 1 as const,
      runId: this.options.runId,
      sequence: this.schemes.length + 1,
      schemeId: artifactHash,
      artifactHash,
      proposedBy: input.proposedBy,
      carrierMode: this.options.carrierMode,
      nonceCommitments: {
        'baby-a': babyA.commitmentHash,
        'baby-b': babyB.commitmentHash,
      },
      publicSaltHash: plainTextHash(input.publicSalt),
      previousEventHash: this.schemes.at(-1)?.eventHash ?? GENESIS_EVENT_HASH,
      changedAt: this.options.clock.now(),
    };
    const event: EncodingSchemeEvent = {
      ...unsigned,
      eventHash: hashCanonical(HASH_DOMAINS.encodingScheme, unsigned),
    };
    this.schemes.push(event);
    return event;
  }

  /** Record Eve's result as hashes and a recovery bit, never raw messages. */
  recordEavesdropperAttempt(
    input: RecordEavesdropperAttemptInput,
  ): EavesdropperAttempt {
    assertNonEmpty('adversaryId', input.adversaryId);
    if (!this.schemes.some((event) => event.schemeId === input.schemeId)) {
      throw new Error(`unknown scheme ${input.schemeId}`);
    }
    const guessCanonical = canonicalJson(input.guess);
    const actualCanonical = canonicalJson(input.actual);
    const attempt: EavesdropperAttempt = {
      version: 1,
      runId: this.options.runId,
      sequence: this.attempts.length + 1,
      role: 'eavesdropper',
      schemeId: input.schemeId,
      adversaryId: input.adversaryId,
      architectureClass: input.architectureClass,
      messageIdHash: plainTextHash(input.messageId),
      guessHash: plainTextHash(guessCanonical),
      recovered: guessCanonical === actualCanonical,
      attemptedAt: this.options.clock.now(),
    };
    this.attempts.push(attempt);
    return attempt;
  }

  /** Canonicalizable `encoding-events` attachment value. */
  report(): EncodingHarnessReport {
    const collisions = this.schemes
      .filter((event) => this.priorArtifacts.has(event.artifactHash))
      .map((event) => event.artifactHash);
    return {
      kind: 'encoding-events',
      analysisVersion: ENCODING_HARNESS_VERSION,
      runId: this.options.runId,
      participants: this.participants,
      carrierMode: this.options.carrierMode,
      cipherThreatModel: this.options.cipherThreatModel,
      syntheticMessagesOnly: true,
      nonceCommitments: [...this.commitments.values()],
      schemeEvents: [...this.schemes],
      eavesdropperAttempts: [...this.attempts],
      uniqueArtifactCount: this.schemes.length - collisions.length,
      priorRegistryCollisions: collisions,
      cryptographicSecurity: CRYPTOGRAPHIC_SECURITY_STATUS,
      researchOnlyNotice: RESEARCH_ONLY_NOTICE,
    };
  }
}
