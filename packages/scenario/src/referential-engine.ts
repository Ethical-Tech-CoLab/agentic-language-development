/**
 * Deterministic referential-game Scenario Engine (ALD-041;
 * SPECIFICATION.md §9.5, §9.6, §10.1, §11.2, §15.3).
 *
 * The engine generates every scenario, private observation, utility matrix,
 * reservation value, and zone of possible agreement from
 * `RunConfig.randomSeed` alone (§14.3 replay fidelity, ALD-041 criterion 1):
 * one `SeededPrng` stream per (split, episode) pair, no wall clock, no ambient
 * randomness, no mutable engine state. Two engines built from the same config
 * and run seed therefore emit byte-identical canonical JSON for the same
 * episode.
 *
 * The task is the CONCEPT-IDEA.md §8/§13 "Naming" stage formalized in
 * RESEARCH.md Appendix D: four candidate objects per episode drawn from
 * `valuesPerAttribute ** attributeCount` attribute combinations ("type
 * codes"), one of which is the target the sender alone observes, giving the
 * pre-registered chance success rate `1 / candidatesPerEpisode` = 0.25.
 *
 * Two properties are load-bearing for the E03 controls and are enforced here
 * rather than left to a caller:
 * - the receiver's candidate order is shuffled independently of the sender's,
 *   so candidate *position* carries no information about the target and a
 *   position-only policy scores exactly at chance;
 * - `scenarioRef` and every `objectRef` are opaque hex derived from the PRNG
 *   (§10.1: no identifier that encodes task state, §11.2: `scenarioRef` is
 *   "not descriptive").
 *
 * All five §9.5 interaction profiles are produced from the same seed material
 * and committed in researcher-only ground truth, including the zone of
 * possible agreement, which is asserted non-empty for
 * `semi-cooperative-negotiation` and provably empty for
 * `no-agreement-control`.
 */
import { z } from 'zod';
import {
  HASH_DOMAINS,
  InteractionModeSchema,
  type AgentActionProposal,
  type BabyRole,
  type Observation,
  type Outcome,
  type RunConfig,
  type ScenarioEngine,
  type ScenarioInstance,
  type ScenarioSplit,
} from '@ald/types';
import { SeededPrng, hashCanonical } from '@ald/hashing';

import { buildObservation } from './observation.js';
import type { HygieneScanOptions } from './hygiene.js';

/** Utility values live in `{1..10}` for every negotiation profile (§9.5). */
const MIN_UTILITY = 1;
const MAX_UTILITY = 10;

/** `emit_symbols` carries at most 16 symbols (SPEC §11.3). */
const MAX_SYMBOLS_PER_MESSAGE = 16;

export type ScenarioErrorCode =
  | 'invalid-config'
  | 'invalid-request'
  | 'invalid-ground-truth'
  | 'oracle-decode'
  | 'zopa-invariant';

/** Every rule this engine enforces surfaces as one of these codes. */
export class ScenarioEngineError extends Error {
  constructor(
    readonly code: ScenarioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Frozen generation config; its canonical hash is `scenarioBundleHash`. */
export interface ReferentialScenarioConfig {
  version: 1;
  /** Attributes per object; the §13 "Attributes" stage raises this. */
  attributeCount: number;
  /** Distinct codes per attribute; `valuesPerAttribute ** attributeCount` types. */
  valuesPerAttribute: number;
  /** Candidates per episode; chance success is its reciprocal (§15.3). */
  candidatesPerEpisode: number;
  /**
   * Type codes absent from all `train` and `validation` candidates and the
   * only targets used in `held-out`; `evaluation` draws from all type codes.
   */
  heldOutTypeCodes: number[];
  /** Carrier inventory used to encode the §9.6 `oracle` artifact. */
  symbolInventory: string[];
  interactionMode: RunConfig['interactionMode'];
  /** Extra derivation label for the evaluation split (RESEARCH.md D.4 slots). */
  evaluationSeedLabel?: string;
}

/** Constructor input: defaults are applied before the bundle hash is taken. */
export type ReferentialScenarioConfigInput = Pick<
  ReferentialScenarioConfig,
  'version' | 'symbolInventory'
> &
  Partial<Omit<ReferentialScenarioConfig, 'version' | 'symbolInventory'>>;

const BabyRoleSchema = z.enum(['baby-a', 'baby-b']);
const typeCode = z.number().int().nonnegative();
const perRoleNumber = z.object({
  'baby-a': z.number(),
  'baby-b': z.number(),
});
const perRoleUtilities = z.object({
  'baby-a': z.record(z.string(), z.number()),
  'baby-b': z.record(z.string(), z.number()),
});

/**
 * Researcher-only ground truth (§9.5: "committed in researcher-only ground
 * truth before the run"). Never delivered to a Baby in any form.
 */
export const ReferentialGroundTruthSchema = z.object({
  targetTypeCode: typeCode,
  targetRef: z.string(),
  /** Candidate type codes in the sender's presentation order. */
  senderOrder: z.array(typeCode),
  /** Candidate type codes in the receiver's independent presentation order. */
  receiverOrder: z.array(typeCode),
  /** Opaque candidate references in receiver order (mirrors the instance). */
  candidateRefs: z.array(z.string()),
  refsByTypeCode: z.record(z.string(), z.string()),
  attributeCodes: z.record(z.string(), z.array(typeCode)),
  interactionMode: InteractionModeSchema,
  roles: z.object({ sender: BabyRoleSchema, receiver: BabyRoleSchema }),
  /** Attributes the receiver observes; `1` under `asymmetric-information`. */
  receiverVisibleAttributeCount: z.number().int().positive(),
  utilities: perRoleUtilities.optional(),
  reservations: perRoleNumber.optional(),
  /** Committed zone of possible agreement, in receiver order (§9.5). */
  zopaRefs: z.array(z.string()).optional(),
});

export type ReferentialGroundTruth = z.infer<typeof ReferentialGroundTruthSchema>;

/** Parse an instance's researcher-only ground truth, or fail loudly. */
export function readGroundTruth(
  groundTruth: Record<string, unknown> | ReferentialGroundTruth,
): ReferentialGroundTruth {
  const parsed = ReferentialGroundTruthSchema.safeParse(groundTruth);
  if (!parsed.success) {
    throw new ScenarioEngineError(
      'invalid-ground-truth',
      'groundTruth was not produced by ReferentialScenarioEngine',
    );
  }
  return parsed.data;
}

/**
 * The §9.5 zone of possible agreement: candidate references whose utility is
 * at least each Baby's reservation value. Pure, so a verifier can recompute
 * it from the committed ground truth without the engine.
 *
 * Profiles without reservation values (`cooperative-signaling`,
 * `asymmetric-information`) impose no acceptability constraint, so every
 * candidate is mutually acceptable and all references are returned.
 */
export function zoneOfPossibleAgreement(
  groundTruth: Record<string, unknown> | ReferentialGroundTruth,
): string[] {
  const truth = readGroundTruth(groundTruth);
  const { utilities, reservations } = truth;
  if (!utilities || !reservations) {
    return [...truth.candidateRefs];
  }
  return truth.candidateRefs.filter((ref, index) => {
    const code = String(truth.receiverOrder[index]);
    const utilityA = utilities['baby-a'][code];
    const utilityB = utilities['baby-b'][code];
    if (utilityA === undefined || utilityB === undefined) {
      return false;
    }
    return (
      utilityA >= reservations['baby-a'] && utilityB >= reservations['baby-b']
    );
  });
}

function requireInteger(value: number, name: string, minimum: number): number {
  if (!Number.isInteger(value) || value < minimum) {
    throw new ScenarioEngineError(
      'invalid-config',
      `${name} must be an integer >= ${minimum}`,
    );
  }
  return value;
}

/** Lowercase hex of the requested length, drawn from the episode stream. */
function nextHex(prng: SeededPrng, length: number): string {
  let hex = '';
  while (hex.length < length) {
    hex += prng.nextUint32().toString(16).padStart(8, '0');
  }
  return hex.slice(0, length);
}

/** Partial Fisher-Yates draw of `count` distinct members of `pool`. */
function sampleDistinct(
  prng: SeededPrng,
  pool: readonly number[],
  count: number,
): number[] {
  const copy = [...pool];
  const picked: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const swap = index + prng.nextInt(copy.length - index);
    const held = copy[index] as number;
    copy[index] = copy[swap] as number;
    copy[swap] = held;
    picked.push(copy[index] as number);
  }
  return picked;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Read `objectRef` out of a task artifact.
 *
 * `AgentActionProposal` is not narrowable by `kind`: `AgentActionProposalSchema`
 * builds its variants from `Object.entries`, which widens each `z.literal(kind)`
 * to `ZodLiteral<string>`, so the inferred type carries `kind: string` and the
 * bare union of every artifact shape (recorded as a contract deviation).
 */
function objectRefOf(
  artifact: AgentActionProposal['publicArtifact'],
): string | undefined {
  if (typeof artifact !== 'object' || artifact === null || !('objectRef' in artifact)) {
    return undefined;
  }
  const ref: unknown = artifact.objectRef;
  return typeof ref === 'string' ? ref : undefined;
}

interface NegotiationState {
  utilities: ReferentialGroundTruth['utilities'];
  reservations: ReferentialGroundTruth['reservations'];
}

export class ReferentialScenarioEngine implements ScenarioEngine {
  readonly config: ReferentialScenarioConfig;
  readonly bundleHash: string;
  readonly chanceSuccessRate: number;
  /** Number of type codes, `valuesPerAttribute ** attributeCount`. */
  readonly typeCodeCount: number;
  /** Inventory symbols per oracle message, fixed so decoding is unambiguous. */
  readonly symbolWidth: number;

  private readonly allTypeCodes: readonly number[];
  private readonly trainTargetPool: readonly number[];
  private readonly heldOutTargetPool: readonly number[];
  private readonly hygieneOptions: HygieneScanOptions;

  constructor(
    config: ReferentialScenarioConfigInput,
    readonly runSeed: string,
    options: HygieneScanOptions = {},
  ) {
    if (config.version !== 1) {
      throw new ScenarioEngineError('invalid-config', 'config.version must be 1');
    }
    if (runSeed.length === 0) {
      throw new ScenarioEngineError('invalid-config', 'runSeed must be non-empty');
    }

    const attributeCount = requireInteger(
      config.attributeCount ?? 2,
      'attributeCount',
      1,
    );
    const valuesPerAttribute = requireInteger(
      config.valuesPerAttribute ?? 4,
      'valuesPerAttribute',
      2,
    );
    const candidatesPerEpisode = requireInteger(
      config.candidatesPerEpisode ?? 4,
      'candidatesPerEpisode',
      2,
    );
    const heldOutTypeCodes = [...(config.heldOutTypeCodes ?? [])].sort(
      (left, right) => left - right,
    );
    const interactionMode = config.interactionMode ?? 'cooperative-signaling';
    const symbolInventory = [...config.symbolInventory];

    const typeCodeCount = valuesPerAttribute ** attributeCount;
    if (!Number.isSafeInteger(typeCodeCount)) {
      throw new ScenarioEngineError(
        'invalid-config',
        'valuesPerAttribute ** attributeCount exceeds the safe integer range',
      );
    }
    if (typeCodeCount < candidatesPerEpisode) {
      throw new ScenarioEngineError(
        'invalid-config',
        'candidatesPerEpisode exceeds the number of distinct object types',
      );
    }
    if (symbolInventory.length < 2) {
      throw new ScenarioEngineError(
        'invalid-config',
        'symbolInventory needs at least two symbols to encode a type code',
      );
    }
    if (new Set(symbolInventory).size !== symbolInventory.length) {
      throw new ScenarioEngineError(
        'invalid-config',
        'symbolInventory must not contain duplicates',
      );
    }
    if (symbolInventory.some((symbol) => symbol.length === 0)) {
      throw new ScenarioEngineError(
        'invalid-config',
        'symbolInventory entries must be non-empty',
      );
    }
    if (config.evaluationSeedLabel !== undefined && config.evaluationSeedLabel === '') {
      throw new ScenarioEngineError(
        'invalid-config',
        'evaluationSeedLabel must be non-empty when provided',
      );
    }
    for (const code of heldOutTypeCodes) {
      if (!Number.isInteger(code) || code < 0 || code >= typeCodeCount) {
        throw new ScenarioEngineError(
          'invalid-config',
          `heldOutTypeCodes entries must be integers in [0, ${typeCodeCount})`,
        );
      }
    }
    if (new Set(heldOutTypeCodes).size !== heldOutTypeCodes.length) {
      throw new ScenarioEngineError(
        'invalid-config',
        'heldOutTypeCodes must not contain duplicates',
      );
    }
    if (heldOutTypeCodes.length >= typeCodeCount) {
      throw new ScenarioEngineError(
        'invalid-config',
        'heldOutTypeCodes must leave at least one train target',
      );
    }
    if (typeCodeCount - heldOutTypeCodes.length < candidatesPerEpisode) {
      throw new ScenarioEngineError(
        'invalid-config',
        'heldOutTypeCodes must leave enough distinct training candidates',
      );
    }

    let width = 1;
    let capacity = symbolInventory.length;
    while (capacity < typeCodeCount) {
      capacity *= symbolInventory.length;
      width += 1;
    }
    if (width > MAX_SYMBOLS_PER_MESSAGE) {
      throw new ScenarioEngineError(
        'invalid-config',
        `encoding ${typeCodeCount} type codes needs ${width} symbols, over the ${MAX_SYMBOLS_PER_MESSAGE}-symbol limit`,
      );
    }

    this.config = {
      version: 1,
      attributeCount,
      valuesPerAttribute,
      candidatesPerEpisode,
      heldOutTypeCodes,
      symbolInventory,
      interactionMode,
      ...(config.evaluationSeedLabel === undefined
        ? {}
        : { evaluationSeedLabel: config.evaluationSeedLabel }),
    };
    this.bundleHash = hashCanonical(HASH_DOMAINS.scenarioBundle, this.config);
    this.chanceSuccessRate = 1 / candidatesPerEpisode;
    this.typeCodeCount = typeCodeCount;
    this.symbolWidth = width;
    this.allTypeCodes = Array.from({ length: typeCodeCount }, (_, code) => code);
    const heldOutSet = new Set(heldOutTypeCodes);
    this.trainTargetPool = this.allTypeCodes.filter((code) => !heldOutSet.has(code));
    this.heldOutTargetPool =
      heldOutTypeCodes.length > 0 ? [...heldOutTypeCodes] : [...this.allTypeCodes];
    this.hygieneOptions = options;
  }

  /** Base-`valuesPerAttribute` attribute codes of a type code, most significant first. */
  attributeCodesFor(code: number): number[] {
    if (!Number.isInteger(code) || code < 0 || code >= this.typeCodeCount) {
      throw new ScenarioEngineError(
        'invalid-request',
        `type code ${code} is outside [0, ${this.typeCodeCount})`,
      );
    }
    const { attributeCount, valuesPerAttribute } = this.config;
    const codes: number[] = [];
    for (let position = attributeCount - 1; position >= 0; position -= 1) {
      const divisor = valuesPerAttribute ** position;
      codes.push(Math.floor(code / divisor) % valuesPerAttribute);
    }
    return codes;
  }

  /** Fixed-width positional encoding of a type code into inventory symbols. */
  encodeTypeCode(code: number): string[] {
    if (!Number.isInteger(code) || code < 0 || code >= this.typeCodeCount) {
      throw new ScenarioEngineError(
        'invalid-request',
        `type code ${code} is outside [0, ${this.typeCodeCount})`,
      );
    }
    const base = this.config.symbolInventory.length;
    const symbols: string[] = [];
    for (let position = this.symbolWidth - 1; position >= 0; position -= 1) {
      const digit = Math.floor(code / base ** position) % base;
      symbols.push(this.config.symbolInventory[digit] as string);
    }
    return symbols;
  }

  /** Inverse of `encodeTypeCode`; throws for anything it did not produce. */
  decodeTypeCode(symbols: readonly string[]): number {
    if (symbols.length !== this.symbolWidth) {
      throw new ScenarioEngineError(
        'oracle-decode',
        `expected ${this.symbolWidth} symbol(s), received ${symbols.length}`,
      );
    }
    const base = this.config.symbolInventory.length;
    let code = 0;
    for (const symbol of symbols) {
      const digit = this.config.symbolInventory.indexOf(symbol);
      if (digit < 0) {
        throw new ScenarioEngineError(
          'oracle-decode',
          'symbol is not in the configured inventory',
        );
      }
      code = code * base + digit;
    }
    if (code >= this.typeCodeCount) {
      throw new ScenarioEngineError(
        'oracle-decode',
        `decoded type code ${code} is outside [0, ${this.typeCodeCount})`,
      );
    }
    return code;
  }

  generate(
    episodeIndex: number,
    split: ScenarioSplit,
    roles: { sender: BabyRole; receiver: BabyRole },
  ): ScenarioInstance {
    if (!Number.isInteger(episodeIndex) || episodeIndex < 0) {
      throw new ScenarioEngineError(
        'invalid-request',
        'episodeIndex must be a non-negative integer',
      );
    }
    if (roles.sender === roles.receiver) {
      throw new ScenarioEngineError(
        'invalid-request',
        'sender and receiver must be different Babies',
      );
    }

    const prng = this.episodePrng(episodeIndex, split);
    const targetPool = this.targetPool(split);
    const targetTypeCode = targetPool[prng.nextInt(targetPool.length)] as number;
    const candidatePool = this.candidatePool(split);
    const distractors = sampleDistinct(
      prng,
      candidatePool.filter((code) => code !== targetTypeCode),
      this.config.candidatesPerEpisode - 1,
    );
    const candidateTypeCodes = [targetTypeCode, ...distractors];

    // Two independent shuffles: the receiver's position of the target is
    // uniform and carries no information (E03 chance-baseline requirement).
    const senderOrder = prng.shuffle(candidateTypeCodes);
    const receiverOrder = prng.shuffle(candidateTypeCodes);

    const scenarioRef = `scn:${nextHex(prng, 16)}`;
    const candidateRefs = this.mintCandidateRefs(prng, candidateTypeCodes.length);

    const refsByTypeCode: Record<string, string> = {};
    receiverOrder.forEach((code, index) => {
      refsByTypeCode[String(code)] = candidateRefs[index] as string;
    });
    const attributeCodes: Record<string, number[]> = {};
    for (const code of candidateTypeCodes) {
      attributeCodes[String(code)] = this.attributeCodesFor(code);
    }

    const negotiation = this.buildNegotiationState(prng, candidateTypeCodes);
    const receiverVisibleAttributeCount =
      this.config.interactionMode === 'asymmetric-information'
        ? 1
        : this.config.attributeCount;

    const groundTruth: ReferentialGroundTruth = {
      targetTypeCode,
      targetRef: refsByTypeCode[String(targetTypeCode)] as string,
      senderOrder,
      receiverOrder,
      candidateRefs,
      refsByTypeCode,
      attributeCodes,
      interactionMode: this.config.interactionMode,
      roles: { sender: roles.sender, receiver: roles.receiver },
      receiverVisibleAttributeCount,
      ...(negotiation
        ? { utilities: negotiation.utilities, reservations: negotiation.reservations }
        : {}),
    };

    if (negotiation) {
      groundTruth.zopaRefs = zoneOfPossibleAgreement(groundTruth);
      this.assertZopaInvariant(groundTruth.zopaRefs);
    }

    const observations = this.buildObservationPayloads(
      groundTruth,
      roles,
      receiverVisibleAttributeCount,
    );

    return {
      scenarioRef,
      episodeIndex,
      split,
      interactionMode: this.config.interactionMode,
      roles: { sender: roles.sender, receiver: roles.receiver },
      observations,
      candidateRefs,
      groundTruth,
      stateHash: hashCanonical(HASH_DOMAINS.scenarioState, {
        scenarioRef,
        groundTruth,
        observations,
      }),
    };
  }

  evaluate(instance: ScenarioInstance, action: AgentActionProposal): Outcome {
    const truth = readGroundTruth(instance.groundTruth);

    const selectedRef =
      action.kind === 'select_object' ? objectRefOf(action.publicArtifact) : undefined;
    if (selectedRef === undefined) {
      return {
        success: false,
        reward: 0,
        details: { reason: 'invalid-selection', actionKind: action.kind },
      };
    }

    if (!instance.candidateRefs.includes(selectedRef)) {
      return {
        success: false,
        reward: 0,
        details: {
          reason: 'invalid-selection',
          selectedRef,
          targetRef: truth.targetRef,
        },
      };
    }

    const selectedTypeCode = truth.receiverOrder[
      instance.candidateRefs.indexOf(selectedRef)
    ] as number;
    const { utilities, reservations } = truth;

    if (utilities && reservations) {
      const utilityA = utilities['baby-a'][String(selectedTypeCode)] ?? 0;
      const utilityB = utilities['baby-b'][String(selectedTypeCode)] ?? 0;
      const agreement =
        utilityA >= reservations['baby-a'] && utilityB >= reservations['baby-b'];
      return {
        success: agreement,
        reward: agreement ? 1 : 0,
        utilities: { 'baby-a': utilityA, 'baby-b': utilityB },
        agreement,
        details: {
          reason: agreement ? 'agreement' : 'no-agreement',
          selectedRef,
          targetRef: truth.targetRef,
          selectedTypeCode,
          targetTypeCode: truth.targetTypeCode,
          jointUtility: utilityA + utilityB,
          reservations: { ...reservations },
          zopaRefs: truth.zopaRefs ?? [],
        },
      };
    }

    const success = selectedRef === truth.targetRef;
    return {
      success,
      reward: success ? 1 : 0,
      details: {
        selectedRef,
        targetRef: truth.targetRef,
        selectedTypeCode,
        targetTypeCode: truth.targetTypeCode,
      },
    };
  }

  /**
   * §9.6 `oracle`: the minimal sufficient artifact — the target's type code
   * encoded in the carrier inventory, and nothing else.
   */
  oracleArtifact(instance: ScenarioInstance): AgentActionProposal['publicArtifact'] {
    const truth = readGroundTruth(instance.groundTruth);
    return { symbols: this.encodeTypeCode(truth.targetTypeCode) };
  }

  /** §9.6 `oracle`: deterministic decode of that artifact into a task action. */
  oracleAction(
    instance: ScenarioInstance,
    artifact: AgentActionProposal['publicArtifact'],
  ): AgentActionProposal {
    if (!('symbols' in artifact)) {
      throw new ScenarioEngineError(
        'oracle-decode',
        'oracle artifact must carry a symbols array',
      );
    }
    const truth = readGroundTruth(instance.groundTruth);
    const decoded = this.decodeTypeCode(artifact.symbols);
    const objectRef = truth.refsByTypeCode[String(decoded)];
    if (objectRef === undefined) {
      throw new ScenarioEngineError(
        'oracle-decode',
        `decoded type code ${decoded} is not a candidate in this episode`,
      );
    }
    return { kind: 'select_object', publicArtifact: { objectRef } };
  }

  /**
   * SPEC §11.2 Observation for one role, built by the ALD-037 builder and
   * passed through the §10.1 hygiene filter (ALD-038: no bypass path).
   */
  observationFor(
    instance: ScenarioInstance,
    runId: string,
    turn: number,
    role: BabyRole,
  ): Observation {
    return buildObservation(
      {
        runId,
        turn,
        recipient: role,
        encoding: 'opaque-numeric',
        payload: instance.observations[role],
        scenarioRef: instance.scenarioRef,
      },
      this.hygieneOptions,
    );
  }

  private episodePrng(episodeIndex: number, split: ScenarioSplit): SeededPrng {
    const base = new SeededPrng(this.runSeed)
      .derive(split)
      .derive(String(episodeIndex));
    const label = this.config.evaluationSeedLabel;
    return split === 'evaluation' && label !== undefined ? base.derive(label) : base;
  }

  private targetPool(split: ScenarioSplit): readonly number[] {
    switch (split) {
      case 'train':
      case 'validation':
        return this.trainTargetPool;
      case 'held-out':
        return this.heldOutTargetPool;
      case 'evaluation':
        return this.allTypeCodes;
      default:
        throw new ScenarioEngineError('invalid-request', `unknown split: ${String(split)}`);
    }
  }

  /**
   * Training and validation candidates exclude every held-out type, not merely
   * held-out targets. Otherwise an unseen combination would leak into learner
   * observations as a distractor before the confirmatory test.
   */
  private candidatePool(split: ScenarioSplit): readonly number[] {
    return split === 'train' || split === 'validation'
      ? this.trainTargetPool
      : this.allTypeCodes;
  }

  private mintCandidateRefs(prng: SeededPrng, count: number): string[] {
    const refs: string[] = [];
    while (refs.length < count) {
      const ref = `o:${nextHex(prng, 12)}`;
      if (!refs.includes(ref)) {
        refs.push(ref);
      }
    }
    return refs;
  }

  private buildNegotiationState(
    prng: SeededPrng,
    candidateTypeCodes: readonly number[],
  ): NegotiationState | undefined {
    const mode = this.config.interactionMode;
    if (
      mode !== 'semi-cooperative-negotiation' &&
      mode !== 'conflicting-negotiation' &&
      mode !== 'no-agreement-control'
    ) {
      return undefined;
    }

    const utilityA: Record<string, number> = {};
    const utilityB: Record<string, number> = {};
    for (const code of candidateTypeCodes) {
      const key = String(code);
      const drawnA = MIN_UTILITY + prng.nextInt(MAX_UTILITY);
      utilityA[key] = drawnA;
      utilityB[key] =
        mode === 'conflicting-negotiation'
          ? // Negatively correlated with small seeded noise in {-1, 0, +1}.
            clamp(MAX_UTILITY + 1 - drawnA + (prng.nextInt(3) - 1), MIN_UTILITY, MAX_UTILITY)
          : MIN_UTILITY + prng.nextInt(MAX_UTILITY);
    }
    const utilities = { 'baby-a': utilityA, 'baby-b': utilityB };

    if (mode === 'semi-cooperative-negotiation') {
      // Anchor both reservations at or below one shared candidate, so the
      // zone of possible agreement is non-empty by construction (§9.5).
      const anchor = String(
        candidateTypeCodes[prng.nextInt(candidateTypeCodes.length)] as number,
      );
      const anchorA = utilityA[anchor] as number;
      const anchorB = utilityB[anchor] as number;
      return {
        utilities,
        reservations: {
          'baby-a': MIN_UTILITY + prng.nextInt(anchorA),
          'baby-b': MIN_UTILITY + prng.nextInt(anchorB),
        },
      };
    }

    if (mode === 'conflicting-negotiation') {
      // Mid-range reservations: agreement may or may not dominate (§9.5).
      return {
        utilities,
        reservations: {
          'baby-a': 4 + prng.nextInt(5),
          'baby-b': 4 + prng.nextInt(5),
        },
      };
    }

    // no-agreement-control: one Baby's reservation is strictly above every
    // candidate's utility for it, so the zone is provably empty (§9.5).
    const blocked: BabyRole = prng.nextInt(2) === 0 ? 'baby-a' : 'baby-b';
    const blockedUtilities = blocked === 'baby-a' ? utilityA : utilityB;
    const blockedReservation =
      Math.max(...candidateTypeCodes.map((code) => blockedUtilities[String(code)] as number)) + 1;
    const openReservation = MIN_UTILITY + prng.nextInt(MAX_UTILITY);
    return {
      utilities,
      reservations:
        blocked === 'baby-a'
          ? { 'baby-a': blockedReservation, 'baby-b': openReservation }
          : { 'baby-a': openReservation, 'baby-b': blockedReservation },
    };
  }

  private assertZopaInvariant(zopaRefs: readonly string[]): void {
    const mode = this.config.interactionMode;
    if (mode === 'semi-cooperative-negotiation' && zopaRefs.length === 0) {
      throw new ScenarioEngineError(
        'zopa-invariant',
        'semi-cooperative-negotiation requires a non-empty zone of possible agreement',
      );
    }
    if (mode === 'no-agreement-control' && zopaRefs.length > 0) {
      throw new ScenarioEngineError(
        'zopa-invariant',
        'no-agreement-control requires a provably empty zone of possible agreement',
      );
    }
  }

  /**
   * Private numeric observations (§10.1: numeric only, §9.5: "each Baby MUST
   * receive only its own permitted observation and utility information").
   *
   * Sender row: attribute codes, then the target flag, then — under a
   * negotiation profile — its own utility for that candidate and its own
   * reservation value. Receiver row: the attribute codes it is permitted to
   * see (one under `asymmetric-information`), then its own utility columns.
   */
  private buildObservationPayloads(
    truth: ReferentialGroundTruth,
    roles: { sender: BabyRole; receiver: BabyRole },
    receiverVisibleAttributeCount: number,
  ): Record<BabyRole, Observation['payload']> {
    const utilityColumns = (role: BabyRole, code: number): number[] => {
      const { utilities, reservations } = truth;
      if (!utilities || !reservations) {
        return [];
      }
      return [utilities[role][String(code)] as number, reservations[role]];
    };

    const senderRows = truth.senderOrder.map((code) => [
      ...(truth.attributeCodes[String(code)] as number[]),
      code === truth.targetTypeCode ? 1 : 0,
      ...utilityColumns(roles.sender, code),
    ]);
    const receiverRows = truth.receiverOrder.map((code) => [
      ...(truth.attributeCodes[String(code)] as number[]).slice(
        0,
        receiverVisibleAttributeCount,
      ),
      ...utilityColumns(roles.receiver, code),
    ]);

    return {
      'baby-a': roles.sender === 'baby-a' ? senderRows : receiverRows,
      'baby-b': roles.sender === 'baby-b' ? senderRows : receiverRows,
    };
  }
}
