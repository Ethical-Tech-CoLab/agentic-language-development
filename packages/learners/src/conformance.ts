/**
 * Reusable learner-adapter conformance harness (ALD-042, ALD-043).
 *
 * It drives two adapters through a referential game without the Symbol
 * Gateway or the Evidence Store, so a track can be checked before either is
 * wired up, and asserts the parts of the contract that are the adapter's own
 * responsibility:
 *
 * - every `act()` returns a `TurnProposalEnvelope` that validates against the
 *   SPEC §11.3 schema and carries the required `intention.recorded` intention
 *   draft (SPEC §6.3: every public tool call MUST include its private
 *   intention draft);
 * - no proposal contains a trusted metadata field — `runId`, `turn`,
 *   `sender`, `hash`, `timestamp` — anywhere inside it, and no envelope
 *   carries free text alongside the tool call (SPEC §6.3, §11.3);
 * - every `receive()` returns a `LedgerDraftEnvelope` that echoes the
 *   delivered `channelEventHash` unchanged and carries an
 *   `interpretation.recorded` draft (SPEC §8.2);
 * - every draft an adapter appends to its private ledger validates against
 *   `LedgerEventDraftSchema` and the LEDGER §5 required-content-field table,
 *   and every string it writes into `agent-native-ledger` content is either an
 *   allowlisted opaque reference or survives the §10.1 human-language scan —
 *   an English gloss riding in a private event is a covert channel between the
 *   Babies as surely as one riding in `publicArtifact` (SPEC §11.4,
 *   CONCEPT-IDEA.md §20.6);
 * - `updatePolicy` is absent exactly for the tracks SPEC §6.2 says it is
 *   absent for.
 *
 * The Gateway-side half of the tool-only enforcement — rejecting a
 * non-conforming proposal at the boundary, counting rejections, and pausing
 * the run — belongs to `@ald/gateway` (SPEC §9.4) and is out of scope here.
 */
import {
  AgentActionProposalSchema,
  GENESIS_HASH,
  HASH_DOMAINS,
  LedgerDraftEnvelopeSchema,
  LedgerEventSchema,
  RunConfigSchema,
  SIGNER_KEY_IDS,
  TurnProposalEnvelopeSchema,
  fixedTokenInventory,
  babyIdForRole,
  type BabyId,
  type BabyRole,
  type DeliveredChannelArtifact,
  type LearnerAdapter,
  type LearnerAdapterFactory,
  type LearnerTrackId,
  type LedgerEvent,
  type LedgerEventDraft,
  type Observation,
  type OutcomeEvent,
  type PolicyCheckpointRef,
  type PrivateLedgerClient,
  type RunConfig,
  type Sha256Hash,
  type TurnProposalEnvelope,
} from '@ald/types';
import {
  SeededPrng,
  computeEntryHash,
  decodeHash,
  deriveSeedHex,
  domainHash,
  hashCanonical,
} from '@ald/hashing';
import { scanForHumanLanguage } from '@ald/scenario';

import { loadLearnerContract, type TrackLearnerContract } from './contracts.js';
import { validateLearnerDraft } from './drafts.js';
import { LearnerConformanceError } from './errors.js';
import {
  attributesFromTypeCode,
  typeCodeCount,
  typeCodeFromAttributes,
} from './game.js';

/** Trusted metadata fields a Baby proposal may never contain (SPEC §11.3). */
export const FORBIDDEN_PROPOSAL_KEYS = [
  'runId',
  'turn',
  'sender',
  'hash',
  'timestamp',
] as const;

/**
 * The exact `publicArtifact` field set permitted for each tool `kind`,
 * derived from `AgentActionProposalSchema` (SPEC §6.3, §11.3) so this stays
 * in lock-step with `@ald/types` rather than duplicating its field list.
 * `z.object()` schemas strip unknown keys on `.parse()` rather than
 * rejecting them, so a raw (unparsed) proposal can carry an extra field the
 * schema would silently have discarded — `assertToolOnlyProposal` checks the
 * raw key set against this map before any parsing happens.
 */
const PUBLIC_ARTIFACT_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  AgentActionProposalSchema.options.map(
    (option) =>
      [
        option.shape.kind.value,
        new Set(Object.keys(option.shape.publicArtifact.shape)),
      ] as const,
  ),
);

/**
 * Own keys of `value` at every level of its prototype chain (excluding
 * `Object.prototype` itself), via `Reflect.ownKeys` rather than
 * `Object.keys`/`Object.entries` — so a trusted-metadata field hidden as a
 * non-enumerable own property, or planted on the object's prototype instead
 * of as an own property, is still found (SPEC §11.3: "no proposal contains a
 * trusted metadata field ... anywhere inside it").
 */
function ownKeysDeep(value: object): string[] {
  const keys = new Set<string>();
  let current: object | null = value;
  while (current !== null && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === 'string') {
        keys.add(key);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  return [...keys];
}

export interface ConformanceOptions {
  /** Mode recorded in the adapter-visible configuration. Default `prototype`. */
  deploymentMode?: RunConfig['deploymentMode'];
  episodes?: number;
  /** Run-level seed; per-Baby seeds are derived from it (SPEC §14.3). */
  seed?: string;
  runId?: string;
  experimentId?: string;
  /** Exact pre-registered model reference; defaults to the harness namespace. */
  modelRef?: string;
  /** Per-turn response deadline; defaults to the protocol's 30 seconds. */
  turnResponseBudgetMs?: number;
  attributeCount?: number;
  valuesPerAttribute?: number;
  candidateCount?: number;
  symbolInventorySize?: number;
  messageLength?: number;
  roleReversalPeriod?: number;
  learningSignal?: RunConfig['learningSignal'];
  learnerContract?: TrackLearnerContract;
  /** Derived-run policy checkpoints to load in `init` (SPEC §7.4). */
  initialPolicies?: Partial<Record<BabyRole, unknown>>;
  /** Call `updatePolicy` after every episode. Default `true` when present. */
  updatePolicy?: boolean;
  /**
   * `'full'` (default) validates every envelope, draft and synthesized ledger
   * event with zod. `'none'` skips schema validation for long training runs;
   * the structural assertions above still run.
   */
  validation?: 'full' | 'none';
  /** Keep every appended draft for inspection. Default `true`. */
  collectDrafts?: boolean;
  /** Hash `exportPolicy()` after every episode. Default `true`. */
  recordPolicyHashes?: boolean;
  /**
   * `'forbidden'` makes `OutcomeEvent.reward` throw when read, which is how a
   * reward-free learning signal is checked (SPEC §6.1 `self-supervised`,
   * intrinsic modes).
   */
  rewardVisibility?: 'value' | 'forbidden';
}

export interface ConformanceResult {
  episodes: number;
  successes: number;
  successRate: number;
  /** `1` or `0` per episode, in episode order. */
  successFlags: number[];
  /** `exportPolicy()` hash after each episode, per Baby. */
  policyHashes: Record<BabyRole, string[]>;
  checkpoints: Record<BabyRole, PolicyCheckpointRef[]>;
  ledgers: Record<BabyRole, RecordingLedgerClient>;
  adapters: Record<BabyRole, LearnerAdapter>;
  symbolInventory: string[];
  config: RunConfig;
  proposals: number;
}

/**
 * Test double for the per-Baby Ledger Writer. It validates each draft the way
 * the real writer would, assigns sequences, chains entry hashes, and returns a
 * `LedgerEvent`. Its signature is a deterministic stand-in, not an Ed25519
 * signature: this harness proves adapter behavior, never evidence integrity.
 */
export class RecordingLedgerClient implements PrivateLedgerClient {
  readonly drafts: LedgerEventDraft[] = [];
  readonly counts = new Map<string, number>();
  /** Turn the runtime would bind the next append to. */
  turn = 0;

  private sequence = 0;
  private previousEntryHash: Sha256Hash = GENESIS_HASH;

  constructor(
    private readonly runId: string,
    private readonly role: BabyRole,
    private readonly validate = true,
    private readonly collect = true,
  ) {}

  get babyId(): BabyId {
    return babyIdForRole(this.role);
  }

  countOf(eventType: string): number {
    return this.counts.get(eventType) ?? 0;
  }

  draftsOf(eventType: string): LedgerEventDraft[] {
    return this.drafts.filter((draft) => draft.eventType === eventType);
  }

  async append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent> {
    const validated = this.validate ? validateLearnerDraft(draft) : draft;
    if (this.validate && validated.contentSchema === 'agent-native-ledger') {
      assertAgentNativeContent(
        validated.content,
        `${this.role} append of ${validated.eventType}`,
      );
    }
    this.counts.set(
      validated.eventType,
      (this.counts.get(validated.eventType) ?? 0) + 1,
    );
    if (this.collect) {
      this.drafts.push(validated);
    }

    this.sequence += 1;
    const stream: 'baby-a-ledger' | 'baby-b-ledger' =
      this.role === 'baby-a' ? 'baby-a-ledger' : 'baby-b-ledger';
    const unsigned = {
      version: 1 as const,
      runId: this.runId,
      babyId: this.babyId,
      sequence: this.sequence,
      turn: this.turn,
      eventType: validated.eventType,
      contentSchema: validated.contentSchema,
      subjectId: validated.subjectId,
      content: validated.content,
      blindingNonce: validated.blindingNonce,
      previousEntryHash: this.previousEntryHash,
      ...(options?.channelEventHash === undefined
        ? {}
        : { channelEventHash: options.channelEventHash }),
      recordedAt: new Date(this.sequence * 1_000).toISOString(),
      writerKeyId: SIGNER_KEY_IDS[stream],
    };
    const entryHash = computeEntryHash(stream, unsigned);
    const event = {
      ...unsigned,
      entryHash,
      writerSignature: `ed25519:${decodeHash(entryHash).toString('base64')}`,
    };
    this.previousEntryHash = entryHash;

    return Promise.resolve(
      this.validate ? LedgerEventSchema.parse(event) : (event as LedgerEvent),
    );
  }
}

interface ConformanceEpisode {
  episodeIndex: number;
  turn: number;
  sender: BabyRole;
  receiver: BabyRole;
  senderPayload: number[][];
  receiverPayload: number[][];
  candidateRefs: string[];
  targetRef: string;
  targetTypeCode: number;
  scenarioRef: string;
}

interface ResolvedConformanceOptions {
  episodes: number;
  seed: string;
  runId: string;
  experimentId: string;
  attributeCount: number;
  valuesPerAttribute: number;
  candidateCount: number;
  symbolInventorySize: number;
  messageLength: number;
  roleReversalPeriod: number;
  validate: boolean;
  collectDrafts: boolean;
  recordPolicyHashes: boolean;
  rewardVisibility: 'value' | 'forbidden';
  updatePolicy: boolean;
}

function resolveOptions(
  options: ConformanceOptions,
): ResolvedConformanceOptions {
  const valuesPerAttribute = options.valuesPerAttribute ?? 4;
  const attributeCount = options.attributeCount ?? 2;
  const candidateCount = options.candidateCount ?? 4;
  if (candidateCount > typeCodeCount(attributeCount, valuesPerAttribute)) {
    throw new LearnerConformanceError(
      'candidateCount exceeds the number of distinct object types',
    );
  }
  return {
    episodes: options.episodes ?? 24,
    seed: options.seed ?? 'ald-learner-conformance',
    runId: options.runId ?? 'run-conformance',
    experimentId: options.experimentId ?? 'E11',
    attributeCount,
    valuesPerAttribute,
    candidateCount,
    symbolInventorySize: options.symbolInventorySize ?? 32,
    messageLength: options.messageLength ?? 1,
    roleReversalPeriod: options.roleReversalPeriod ?? 1,
    validate: (options.validation ?? 'full') === 'full',
    collectDrafts: options.collectDrafts ?? true,
    recordPolicyHashes: options.recordPolicyHashes ?? true,
    rewardVisibility: options.rewardVisibility ?? 'value',
    updatePolicy: options.updatePolicy ?? true,
  };
}

/**
 * Build a valid `RunConfig` for the harness. Every hash field is a real
 * domain-separated hash of the harness's own inputs, so the configuration
 * parses under `RunConfigSchema` including its track/learning-signal
 * cross-checks.
 */
export function buildConformanceRunConfig(
  track: LearnerTrackId,
  options: ConformanceOptions = {},
): RunConfig {
  const resolved = resolveOptions(options);
  const learningSignal =
    options.learningSignal ?? (track === 'scratch-rl' ? 'extrinsic-task' : 'none');
  const learner = {
    track,
    modelRef: options.modelRef ?? `reference:${track}`,
    trainingIsolation: 'independent' as const,
  };

  return RunConfigSchema.parse({
    version: 1,
    runId: resolved.runId,
    deploymentMode: options.deploymentMode ?? 'prototype',
    babyA: learner,
    babyB: learner,
    symmetricTracks: true,
    learningSignal,
    communicationCondition: 'normal',
    interactionMode: 'cooperative-signaling',
    carrierMode: 'fixed-token',
    symbolInventorySize: resolved.symbolInventorySize,
    maxSymbolsPerMessage: resolved.messageLength,
    affectMode: 'none',
    affectWindowSchedule: 'none',
    observationEncoding: 'opaque-numeric',
    roleReversalPeriod: resolved.roleReversalPeriod,
    turnResponseBudgetMs: options.turnResponseBudgetMs ?? 30_000,
    maxTurnsPerRun: Math.max(resolved.episodes, 1),
    maxConsecutiveRejections: 3,
    ledgerLagTurns: 0,
    curriculumMode: 'fixed-schedule',
    cipherThreatModel: 'post-run-disclosure',
    interventionSuiteThreshold: 0.8,
    evaluationSeeds: 3,
    checkpointEventInterval: 200,
    checkpointTimeIntervalMs: 60_000,
    anchorNetwork: 'base-sepolia',
    finalityPolicy: 'confirmed-1',
    prototypeRetentionDays: 30,
    scenarioBundleHash: hashCanonical(HASH_DOMAINS.scenarioBundle, {
      generator: 'conformance-referential-game',
      attributeCount: resolved.attributeCount,
      valuesPerAttribute: resolved.valuesPerAttribute,
      candidateCount: resolved.candidateCount,
      seed: resolved.seed,
    }),
    promptBundleHash: domainHash(HASH_DOMAINS.promptBundle, track),
    protocolGitCommit: 'conformance-harness',
    preRegistrationHash: domainHash(
      HASH_DOMAINS.preRegistration,
      `${resolved.experimentId}:${track}`,
    ),
    randomSeed: resolved.seed,
    experimentId: resolved.experimentId,
  });
}

/**
 * One episode of the referential game: `candidateCount` distinct object types,
 * one target, and independent candidate orders for the two roles. Object
 * references are opaque hashes carrying no attribute information (SPEC §11.2).
 */
function generateEpisode(
  episodeIndex: number,
  resolved: ResolvedConformanceOptions,
): ConformanceEpisode {
  const prng = new SeededPrng(resolved.seed).derive(`episode/${episodeIndex}`);
  const typeCount = typeCodeCount(
    resolved.attributeCount,
    resolved.valuesPerAttribute,
  );
  const typeCodes = prng
    .shuffle(Array.from({ length: typeCount }, (_, index) => index))
    .slice(0, resolved.candidateCount);
  const attributes = typeCodes.map((typeCode) =>
    attributesFromTypeCode(
      typeCode,
      resolved.attributeCount,
      resolved.valuesPerAttribute,
    ),
  );
  const targetPosition = prng.nextInt(resolved.candidateCount);
  const receiverOrder = prng.shuffle(
    Array.from({ length: resolved.candidateCount }, (_, index) => index),
  );

  const senderPayload = attributes.map((codes, position) => [
    ...codes,
    position === targetPosition ? 1 : 0,
  ]);
  const receiverPayload = receiverOrder.map(
    (senderPosition) => [...(attributes[senderPosition] as number[])],
  );
  const candidateRefs = receiverOrder.map((_, position) =>
    `object:${domainHash(HASH_DOMAINS.observation, `${resolved.seed}/${episodeIndex}/${position}`)}`,
  );
  const targetReceiverPosition = receiverOrder.indexOf(targetPosition);
  const senderRole: BabyRole =
    Math.floor(episodeIndex / resolved.roleReversalPeriod) % 2 === 0
      ? 'baby-a'
      : 'baby-b';

  return {
    episodeIndex,
    turn: episodeIndex + 1,
    sender: senderRole,
    receiver: senderRole === 'baby-a' ? 'baby-b' : 'baby-a',
    senderPayload,
    receiverPayload,
    candidateRefs,
    targetRef: candidateRefs[targetReceiverPosition] as string,
    targetTypeCode: typeCodeFromAttributes(
      attributes[targetPosition] as number[],
      resolved.valuesPerAttribute,
    ),
    scenarioRef: `scenario:${domainHash(HASH_DOMAINS.scenarioState, `${resolved.seed}/${episodeIndex}`)}`,
  };
}

function observationFor(
  episode: ConformanceEpisode,
  role: BabyRole,
  runId: string,
): Observation {
  return {
    runId,
    turn: episode.turn,
    recipient: role,
    encoding: 'opaque-numeric',
    payload:
      role === episode.sender ? episode.senderPayload : episode.receiverPayload,
    scenarioRef: episode.scenarioRef,
  };
}

/** SPEC §6.3/§11.3: a Baby proposal is a tool call and nothing else. */
export function assertToolOnlyProposal(
  envelope: unknown,
  where: string,
): TurnProposalEnvelope {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new LearnerConformanceError(`${where}: act() must return an object`);
  }
  const keys = Object.keys(envelope);
  const allowed = ['proposal', 'privateLedgerDraft'];
  const extra = keys.filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new LearnerConformanceError(
      `${where}: proposal envelope carries non-tool fields: ${extra.join(', ')}`,
    );
  }
  for (const key of allowed) {
    if (!keys.includes(key)) {
      throw new LearnerConformanceError(`${where}: envelope is missing ${key}`);
    }
  }

  const record = envelope as { proposal?: unknown };
  const proposal = record.proposal;
  if (typeof proposal !== 'object' || proposal === null) {
    throw new LearnerConformanceError(`${where}: proposal must be an object`);
  }
  const proposalKeys = Object.keys(proposal).sort();
  if (
    proposalKeys.length !== 2 ||
    proposalKeys[0] !== 'kind' ||
    proposalKeys[1] !== 'publicArtifact'
  ) {
    throw new LearnerConformanceError(
      `${where}: a proposal must hold exactly kind and publicArtifact, found ${proposalKeys.join(', ')}`,
    );
  }

  const { kind, publicArtifact } = proposal as {
    kind: unknown;
    publicArtifact: unknown;
  };
  if (typeof kind !== 'string') {
    throw new LearnerConformanceError(`${where}: proposal.kind must be a string`);
  }
  const allowedArtifactFields = PUBLIC_ARTIFACT_FIELDS.get(kind);
  if (allowedArtifactFields === undefined) {
    throw new LearnerConformanceError(
      `${where}: proposal.kind "${kind}" is not a recognized tool (SPEC §6.3)`,
    );
  }
  if (
    typeof publicArtifact !== 'object' ||
    publicArtifact === null ||
    Array.isArray(publicArtifact)
  ) {
    throw new LearnerConformanceError(`${where}: proposal.publicArtifact must be an object`);
  }

  // Checked before the artifact key-set match below: a field that is both
  // an extra key and a trusted-metadata name (e.g. an injected `runId`) is
  // diagnosed as the trusted-field violation it is, not as a generic
  // "wrong keys" mismatch.
  assertNoTrustedFields(proposal, where, 'proposal');

  // Object.keys, not ownKeysDeep: a hidden (non-enumerable or
  // prototype-carried) key that is not a trusted-field name would silently
  // vanish under `JSON.stringify`, so it can never reach a receiver or the
  // channel-event hash preimage either — the key-set check only needs to
  // police what is actually visible there.
  const artifactKeys = Object.keys(publicArtifact).sort();
  const expectedKeys = [...allowedArtifactFields].sort();
  const artifactKeysMatch =
    artifactKeys.length === expectedKeys.length &&
    artifactKeys.every((key, index) => key === expectedKeys[index]);
  if (!artifactKeysMatch) {
    throw new LearnerConformanceError(
      `${where}: publicArtifact for kind "${kind}" must hold exactly ${expectedKeys.join(', ')}, found ${artifactKeys.join(', ')}`,
    );
  }

  return envelope as TurnProposalEnvelope;
}

function assertNoTrustedFields(
  value: unknown,
  where: string,
  path: string,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoTrustedFields(item, where, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const key of ownKeysDeep(value)) {
    if (
      FORBIDDEN_PROPOSAL_KEYS.some(
        (forbidden) => forbidden.toLowerCase() === key.toLowerCase(),
      )
    ) {
      throw new LearnerConformanceError(
        `${where}: ${path}.${key} is a runtime-assigned trusted field and must not appear in a proposal`,
      );
    }
    const nested = (value as Record<string, unknown>)[key];
    assertNoTrustedFields(nested, where, `${path}.${key}`);
  }
}

/**
 * Structured opaque-reference formats the reference adapters legitimately
 * write into `agent-native-ledger` content (SPEC §11.4): proposal, channel,
 * policy and scenario hashes, the `symbol:`/`hyp:` term and hypothesis
 * references of CONCEPT-IDEA.md §11.2, the Scenario Engine's `o:<hex>`
 * candidate references and the harness's `object:<hash>` stand-ins, and the
 * `outcome:<turn>` evidence reference.
 *
 * The list is deliberately narrow — every pattern is anchored and admits only
 * hex, digits, or a fixed-token symbol id, so no English can hide inside one.
 * A string that matches none of them is not rejected outright (a track may
 * have its own opaque vocabulary); it is handed to the §10.1 scan instead.
 */
export const AGENT_NATIVE_REFERENCE_FORMATS: readonly RegExp[] = [
  /^sha256:[0-9a-f]{64}$/u,
  /^(?:proposal|channel|policy|scenario|object|entry):sha256:[0-9a-f]{64}$/u,
  /^(?:o|scn|obj):[0-9a-f]{8,64}$/u,
  /^S[0-9]{2,3}$/u,
  /^symbol:S[0-9]{2,3}$/u,
  /^hyp:S[0-9]{2,3}:[0-9]+$/u,
  /^outcome:[0-9]+$/u,
];

function isOpaqueReference(value: string): boolean {
  return AGENT_NATIVE_REFERENCE_FORMATS.some((pattern) => pattern.test(value));
}

function collectStringValues(
  value: unknown,
  into: string[],
  seen: WeakSet<object>,
): void {
  if (typeof value === 'string') {
    into.push(value);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStringValues(item, into, seen);
    }
    return;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectStringValues(nested, into, seen);
  }
}

/**
 * SPEC §11.4 and CONCEPT-IDEA.md §20.6: an `agent-native-ledger` event carries
 * association weights, distributions, confidences and opaque references —
 * never an English gloss. The harness cannot certify "no natural language" by
 * inspecting `contentSchema` alone, because the field is a claim the adapter
 * makes about itself; this is the check behind the claim.
 *
 * Only string *values* are scanned. Content keys are the adapter's own
 * agent-native field names (`targetTypeCode`, `associationWeights`), which the
 * §10.1 token list would flag for vocabulary they use structurally rather than
 * as language.
 */
export function assertAgentNativeContent(
  content: Record<string, unknown>,
  where: string,
): void {
  const strings: string[] = [];
  collectStringValues(content, strings, new WeakSet<object>());
  const suspect = strings.filter((value) => !isOpaqueReference(value));
  const hits = scanForHumanLanguage(suspect);
  if (hits.length > 0) {
    throw new LearnerConformanceError(
      `${where}: agent-native content carries ${String(hits.length)} human-language string(s) (SPEC §11.4); first offending field length ${String((hits[0] as string).length)}`,
    );
  }
}

/**
 * Reject any key a schema silently dropped.
 *
 * `z.object()` strips unknown keys on `.parse()` rather than rejecting them,
 * and the harness keeps using the *raw* envelope afterwards — it is the raw
 * `publicArtifact` that is hashed into the channel event and handed to the
 * other adapter's `receive()`. So a field the schema discarded is not
 * harmless: it is a covert channel that the schema check hides rather than
 * catches (SPEC §6.3, §11.3). Extra keys are compared in the raw-to-parsed
 * direction only, so a schema default the parse *adds* (`evidenceRefs: []`) is
 * not mistaken for a violation.
 */
function assertNoStrippedKeys(
  raw: unknown,
  parsed: unknown,
  where: string,
  path: string,
): void {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) {
      return;
    }
    raw.forEach((item, index) => {
      assertNoStrippedKeys(item, parsed[index], where, `${path}[${index}]`);
    });
    return;
  }
  if (typeof raw !== 'object' || raw === null) {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return;
  }
  const parsedRecord = parsed as Record<string, unknown>;
  for (const key of ownKeysDeep(raw)) {
    if (!(key in parsedRecord)) {
      throw new LearnerConformanceError(
        `${where}: ${path}.${key} is not part of the SPEC §11.3 schema and must not ride alongside the tool call`,
      );
    }
    assertNoStrippedKeys(
      (raw as Record<string, unknown>)[key],
      parsedRecord[key],
      where,
      `${path}.${key}`,
    );
  }
}

/**
 * One envelope, checked against what its schema actually accepted: no key the
 * schema stripped survives in the raw value the harness goes on to use, and
 * the private draft it carries holds agent-native content only.
 */
function assertSchemaFaithfulEnvelope(
  raw: unknown,
  parsed: { privateLedgerDraft: LedgerEventDraft },
  where: string,
): void {
  assertNoStrippedKeys(raw, parsed, where, 'envelope');
  if (parsed.privateLedgerDraft.contentSchema === 'agent-native-ledger') {
    assertAgentNativeContent(parsed.privateLedgerDraft.content, where);
  }
}

function buildOutcome(
  base: OutcomeEvent,
  visibility: 'value' | 'forbidden',
): OutcomeEvent {
  if (visibility === 'value') {
    return base;
  }
  const outcome: Record<string, unknown> = { ...base };
  delete outcome.reward;
  Object.defineProperty(outcome, 'reward', {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new LearnerConformanceError(
        'outcome.reward was read under a reward-free learning signal',
      );
    },
  });
  return outcome as unknown as OutcomeEvent;
}

/**
 * Run `episodes` referential-game episodes between two adapters built by
 * `factory`, asserting the adapter half of the SPEC §6.2/§6.3 contract on
 * every turn. Throws `LearnerConformanceError` on the first violation.
 */
export async function runLearnerAdapterConformance(
  factory: LearnerAdapterFactory,
  options: ConformanceOptions = {},
): Promise<ConformanceResult> {
  const resolved = resolveOptions(options);
  const config = buildConformanceRunConfig(factory.track, options);
  const contract = options.learnerContract ?? loadLearnerContract(factory.track);
  const symbolInventory = fixedTokenInventory(resolved.symbolInventorySize);
  const roles: BabyRole[] = ['baby-a', 'baby-b'];

  const adapters = {} as Record<BabyRole, LearnerAdapter>;
  const ledgers = {} as Record<BabyRole, RecordingLedgerClient>;
  const policyHashes: Record<BabyRole, string[]> = {
    'baby-a': [],
    'baby-b': [],
  };
  const checkpoints: Record<BabyRole, PolicyCheckpointRef[]> = {
    'baby-a': [],
    'baby-b': [],
  };

  for (const role of roles) {
    const adapter = factory.create();
    if (adapter.track !== factory.track) {
      throw new LearnerConformanceError(
        `factory.track is ${factory.track} but the adapter reports ${adapter.track}`,
      );
    }
    const updatesExpected =
      factory.track !== 'no-learning' && factory.track !== 'frozen-llm';
    if (updatesExpected !== (adapter.updatePolicy !== undefined)) {
      throw new LearnerConformanceError(
        `track ${factory.track} must ${updatesExpected ? '' : 'not '}expose updatePolicy (SPEC §6.2)`,
      );
    }

    const ledger = new RecordingLedgerClient(
      config.runId,
      role,
      resolved.validate,
      resolved.collectDrafts,
    );
    await adapter.init({
      runId: config.runId,
      role,
      babyId: babyIdForRole(role),
      config,
      learnerContract: contract,
      seed: deriveSeedHex(resolved.seed, role),
      symbolInventory,
      ledger,
      ...(options.initialPolicies?.[role] === undefined
        ? {}
        : { initialPolicy: options.initialPolicies[role] }),
    });
    adapters[role] = adapter;
    ledgers[role] = ledger;
  }

  const successFlags: number[] = [];
  let successes = 0;
  let proposals = 0;

  for (let index = 0; index < resolved.episodes; index += 1) {
    const episode = generateEpisode(index, resolved);
    const sender = adapters[episode.sender] as LearnerAdapter;
    const receiver = adapters[episode.receiver] as LearnerAdapter;
    (ledgers[episode.sender] as RecordingLedgerClient).turn = episode.turn;
    (ledgers[episode.receiver] as RecordingLedgerClient).turn = episode.turn;

    await sender.observe(observationFor(episode, episode.sender, config.runId));
    await receiver.observe(
      observationFor(episode, episode.receiver, config.runId),
    );

    const senderEnvelope = await sender.act({
      turn: episode.turn,
      role: 'sender',
      responseBudgetMs: config.turnResponseBudgetMs,
      availableActions: ['emit_symbols'],
    });
    proposals += 1;
    const senderProposal = assertToolOnlyProposal(
      senderEnvelope,
      `episode ${index} sender act()`,
    );
    if (resolved.validate) {
      assertSchemaFaithfulEnvelope(
        senderEnvelope,
        TurnProposalEnvelopeSchema.parse(senderProposal),
        `episode ${index} sender act()`,
      );
      validateLearnerDraft(senderProposal.privateLedgerDraft);
    }
    assertIntentionDraft(senderProposal, `episode ${index} sender act()`);
    if (senderProposal.proposal.kind !== 'emit_symbols') {
      throw new LearnerConformanceError(
        `episode ${index}: a sender must emit symbols, got ${senderProposal.proposal.kind}`,
      );
    }

    // Standing in for the Evidence Writer's atomic commit (SPEC §8.2): the
    // sender's intention event is committed to its private ledger together
    // with the channel event, before anything is delivered.
    await (ledgers[episode.sender] as RecordingLedgerClient).append(
      senderProposal.privateLedgerDraft,
    );

    const channelEventHash = hashCanonical(HASH_DOMAINS.channelEvent, {
      turn: episode.turn,
      logicalSender: episode.sender,
      publicArtifact: senderProposal.proposal.publicArtifact,
    });
    const delivery: DeliveredChannelArtifact = {
      runId: config.runId,
      turn: episode.turn,
      logicalSender: episode.sender,
      carrier: config.carrierMode,
      publicArtifact: senderProposal.proposal.publicArtifact,
      channelEventHash,
    };

    const interpretation = await receiver.receive(delivery);
    if (resolved.validate) {
      assertSchemaFaithfulEnvelope(
        interpretation,
        LedgerDraftEnvelopeSchema.parse(interpretation),
        `episode ${index} receive()`,
      );
      validateLearnerDraft(interpretation.privateLedgerDraft);
    }
    if (interpretation.channelEventHash !== channelEventHash) {
      throw new LearnerConformanceError(
        `episode ${index}: receive() must echo the delivered channelEventHash unchanged`,
      );
    }
    if (interpretation.privateLedgerDraft.eventType !== 'interpretation.recorded') {
      throw new LearnerConformanceError(
        `episode ${index}: receive() must return an interpretation.recorded draft`,
      );
    }
    if (interpretation.privateLedgerDraft.contentSchema !== 'agent-native-ledger') {
      throw new LearnerConformanceError(
        `episode ${index}: an initially ungrounded adapter must use the agent-native content schema`,
      );
    }

    // Standing in for the Gateway forwarding the receiver's interpretation
    // (SPEC §8.2): it references the delivered channel event hash and is
    // committed before the receiver's own next proposal is accepted.
    await (ledgers[episode.receiver] as RecordingLedgerClient).append(
      interpretation.privateLedgerDraft,
      { channelEventHash },
    );

    const receiverEnvelope = await receiver.act({
      turn: episode.turn,
      role: 'receiver',
      responseBudgetMs: config.turnResponseBudgetMs,
      availableActions: ['select_object'],
      candidateRefs: episode.candidateRefs,
    });
    proposals += 1;
    const receiverProposal = assertToolOnlyProposal(
      receiverEnvelope,
      `episode ${index} receiver act()`,
    );
    if (resolved.validate) {
      assertSchemaFaithfulEnvelope(
        receiverEnvelope,
        TurnProposalEnvelopeSchema.parse(receiverProposal),
        `episode ${index} receiver act()`,
      );
      validateLearnerDraft(receiverProposal.privateLedgerDraft);
    }
    assertIntentionDraft(receiverProposal, `episode ${index} receiver act()`);
    const selection = receiverProposal.proposal;
    if (selection.kind !== 'select_object') {
      throw new LearnerConformanceError(
        `episode ${index}: a receiver must select an object, got ${selection.kind}`,
      );
    }
    // `AgentActionProposal.kind` is widened to `string` by the schema (see this
    // package's contractDeviations), so the variant cannot be narrowed by TypeScript
    // and the artifact field is extracted with a runtime check instead.
    const objectRef = selectedObjectRef(
      selection.publicArtifact,
      `episode ${index} receiver act()`,
    );
    if (!episode.candidateRefs.includes(objectRef)) {
      throw new LearnerConformanceError(
        `episode ${index}: the selected objectRef is not one of the offered candidates`,
      );
    }

    await (ledgers[episode.receiver] as RecordingLedgerClient).append(
      receiverProposal.privateLedgerDraft,
    );

    const success = objectRef === episode.targetRef;
    successFlags.push(success ? 1 : 0);
    if (success) {
      successes += 1;
    }

    for (const role of [episode.sender, episode.receiver] as const) {
      const adapter = adapters[role] as LearnerAdapter;
      await adapter.onOutcome(
        buildOutcome(
          {
            runId: config.runId,
            turn: episode.turn,
            role: role === episode.sender ? 'sender' : 'receiver',
            success,
            reward: success ? 1 : 0,
            payload: [success ? 1 : 0],
          },
          resolved.rewardVisibility,
        ),
      );
      if (resolved.updatePolicy && adapter.updatePolicy !== undefined) {
        checkpoints[role].push(
          await adapter.updatePolicy({
            runId: config.runId,
            turns: [episode.turn],
            learningSignal: config.learningSignal,
          }),
        );
      }
      if (resolved.recordPolicyHashes) {
        policyHashes[role].push(
          hashCanonical(HASH_DOMAINS.policyCheckpoint, adapter.exportPolicy()),
        );
      }
    }
  }

  return {
    episodes: resolved.episodes,
    successes,
    successRate: resolved.episodes === 0 ? 0 : successes / resolved.episodes,
    successFlags,
    policyHashes,
    checkpoints,
    ledgers,
    adapters,
    symbolInventory,
    config,
    proposals,
  };
}

function selectedObjectRef(publicArtifact: unknown, where: string): string {
  const objectRef = (publicArtifact as { objectRef?: unknown }).objectRef;
  if (typeof objectRef !== 'string' || objectRef.length === 0) {
    throw new LearnerConformanceError(
      `${where}: select_object requires a non-empty objectRef`,
    );
  }
  return objectRef;
}

function assertIntentionDraft(
  envelope: TurnProposalEnvelope,
  where: string,
): void {
  const draft = envelope.privateLedgerDraft;
  if (draft.eventType !== 'intention.recorded') {
    throw new LearnerConformanceError(
      `${where}: every public tool call must carry an intention.recorded draft (SPEC §6.3), got ${draft.eventType}`,
    );
  }
  if (draft.contentSchema !== 'agent-native-ledger') {
    throw new LearnerConformanceError(
      `${where}: an initially ungrounded adapter must use the agent-native content schema`,
    );
  }
}

/** Success rate over the final `count` episodes of a conformance run. */
export function tailSuccessRate(
  result: Pick<ConformanceResult, 'successFlags'>,
  count: number,
): number {
  const tail = result.successFlags.slice(-count);
  if (tail.length === 0) {
    return 0;
  }
  return tail.reduce((sum, flag) => sum + flag, 0) / tail.length;
}
