/**
 * Deterministic fixtures for the `@ald/interventions` tests.
 *
 * `playTabularGame` drives two real `scratch-rl` adapters through a small
 * referential game with the real `RecordingLedgerClient` from
 * `@ald/learners`, so the claim index and the probe planner are tested
 * against the ledger events the reference track actually writes
 * (`hypothesis.created`/`revised` with `argmaxTypeCode` and `confidence`,
 * `intention.recorded`/`interpretation.recorded` with `symbols`) rather than
 * against hand-written content this package invented.
 *
 * Everything is seeded: the same options always produce the same events,
 * policies and episodes.
 */
import {
  RecordingLedgerClient,
  attributesFromTypeCode,
  buildConformanceRunConfig,
  createTabularReinforceAdapterFactory,
  loadLearnerContract,
  typeCodeFromAttributes,
} from '@ald/learners';
import { SeededPrng, deriveSeedHex, domainHash, hashCanonical } from '@ald/hashing';
import {
  HASH_DOMAINS,
  babyIdForRole,
  fixedTokenInventory,
  type BabyRole,
  type LedgerEvent,
  type LedgerEventDraft,
  type PrivateLedgerClient,
  type RunConfig,
  type Sha256Hash,
} from '@ald/types';

/** Captures the `LedgerEvent`s the writer returns, not just the drafts. */
class CapturingLedger implements PrivateLedgerClient {
  readonly events: LedgerEvent[] = [];

  constructor(private readonly inner: RecordingLedgerClient) {}

  setTurn(turn: number): void {
    this.inner.turn = turn;
  }

  async append(
    draft: LedgerEventDraft,
    options?: { channelEventHash?: Sha256Hash },
  ): Promise<LedgerEvent> {
    const event = await this.inner.append(draft, options);
    this.events.push(event);
    return event;
  }
}

export interface PlayedEpisode {
  readonly turn: number;
  readonly sender: BabyRole;
  readonly receiver: BabyRole;
  readonly symbols: readonly string[];
  readonly candidateRefs: readonly string[];
  /** Researcher-only ground truth per candidate, in the receiver's order. */
  readonly candidateTypeCodes: readonly number[];
  readonly targetRef: string;
  readonly targetTypeCode: number;
  readonly chosenRef: string;
  readonly success: boolean;
}

export interface GamePlay {
  readonly config: RunConfig;
  readonly symbolInventory: readonly string[];
  readonly events: Record<BabyRole, LedgerEvent[]>;
  readonly policies: Record<BabyRole, unknown>;
  readonly episodes: readonly PlayedEpisode[];
}

export interface GameOptions {
  readonly episodes?: number;
  readonly seed?: string;
  readonly messageLength?: number;
  readonly symbolInventorySize?: number;
  readonly attributeCount?: number;
  readonly valuesPerAttribute?: number;
  readonly candidateCount?: number;
}

/** Two `scratch-rl` adapters playing a seeded referential game. */
export async function playTabularGame(
  options: GameOptions = {},
): Promise<GamePlay> {
  const episodes = options.episodes ?? 60;
  const seed = options.seed ?? 'ald-interventions-fixture';
  const messageLength = options.messageLength ?? 2;
  const symbolInventorySize = options.symbolInventorySize ?? 8;
  const attributeCount = options.attributeCount ?? 2;
  const valuesPerAttribute = options.valuesPerAttribute ?? 4;
  const candidateCount = options.candidateCount ?? 4;

  const config = buildConformanceRunConfig('scratch-rl', {
    seed,
    episodes,
    messageLength,
    symbolInventorySize,
    attributeCount,
    valuesPerAttribute,
    candidateCount,
  });
  const symbolInventory = fixedTokenInventory(symbolInventorySize);
  const factory = createTabularReinforceAdapterFactory({
    attributeCount,
    valuesPerAttribute,
    messageLength,
  });
  const contract = loadLearnerContract('scratch-rl');

  const roles: BabyRole[] = ['baby-a', 'baby-b'];
  const adapters = {} as Record<BabyRole, ReturnType<typeof factory.create>>;
  const ledgers = {} as Record<BabyRole, CapturingLedger>;

  for (const role of roles) {
    const ledger = new CapturingLedger(
      new RecordingLedgerClient(config.runId, role, true, false),
    );
    const adapter = factory.create();
    await adapter.init({
      runId: config.runId,
      role,
      babyId: babyIdForRole(role),
      config,
      learnerContract: contract,
      seed: deriveSeedHex(seed, role),
      symbolInventory: [...symbolInventory],
      ledger,
    });
    adapters[role] = adapter;
    ledgers[role] = ledger;
  }

  const played: PlayedEpisode[] = [];
  const typeCount = valuesPerAttribute ** attributeCount;

  for (let index = 0; index < episodes; index += 1) {
    const prng = new SeededPrng(seed).derive(`fixture-episode/${index}`);
    const typeCodes = prng
      .shuffle(Array.from({ length: typeCount }, (_unused, code) => code))
      .slice(0, candidateCount);
    const attributes = typeCodes.map((typeCode) =>
      attributesFromTypeCode(typeCode, attributeCount, valuesPerAttribute),
    );
    const targetPosition = prng.nextInt(candidateCount);
    const receiverOrder = prng.shuffle(
      Array.from({ length: candidateCount }, (_unused, position) => position),
    );
    const senderPayload = attributes.map((codes, position) => [
      ...codes,
      position === targetPosition ? 1 : 0,
    ]);
    const receiverPayload = receiverOrder.map((senderPosition) => [
      ...(attributes[senderPosition] as number[]),
    ]);
    const candidateRefs = receiverOrder.map(
      (_unused, position) =>
        `object:${domainHash(HASH_DOMAINS.observation, `${seed}/${index}/${position}`)}`,
    );
    const candidateTypeCodes = receiverPayload.map((row) =>
      typeCodeFromAttributes(row, valuesPerAttribute),
    );
    const targetRef = candidateRefs[
      receiverOrder.indexOf(targetPosition)
    ] as string;
    const turn = index;
    const sender: BabyRole = index % 2 === 0 ? 'baby-a' : 'baby-b';
    const receiver: BabyRole = sender === 'baby-a' ? 'baby-b' : 'baby-a';
    const senderAdapter = adapters[sender];
    const receiverAdapter = adapters[receiver];
    ledgers[sender].setTurn(turn);
    ledgers[receiver].setTurn(turn);

    await senderAdapter.observe({
      runId: config.runId,
      turn,
      recipient: sender,
      encoding: 'opaque-numeric',
      payload: senderPayload,
      scenarioRef: `scenario:${index}`,
    });
    await receiverAdapter.observe({
      runId: config.runId,
      turn,
      recipient: receiver,
      encoding: 'opaque-numeric',
      payload: receiverPayload,
      scenarioRef: `scenario:${index}`,
    });

    const senderEnvelope = await senderAdapter.act({
      turn,
      role: 'sender',
      responseBudgetMs: config.turnResponseBudgetMs,
      availableActions: ['emit_symbols'],
    });
    await ledgers[sender].append(senderEnvelope.privateLedgerDraft);
    const symbols = (
      senderEnvelope.proposal.publicArtifact as { symbols: string[] }
    ).symbols;

    const channelEventHash = hashCanonical(HASH_DOMAINS.channelEvent, {
      turn,
      logicalSender: sender,
      publicArtifact: senderEnvelope.proposal.publicArtifact,
    });
    const interpretation = await receiverAdapter.receive({
      runId: config.runId,
      turn,
      logicalSender: sender,
      carrier: config.carrierMode,
      publicArtifact: senderEnvelope.proposal.publicArtifact,
      channelEventHash,
    });
    await ledgers[receiver].append(interpretation.privateLedgerDraft, {
      channelEventHash,
    });

    const receiverEnvelope = await receiverAdapter.act({
      turn,
      role: 'receiver',
      responseBudgetMs: config.turnResponseBudgetMs,
      availableActions: ['select_object'],
      candidateRefs: [...candidateRefs],
    });
    await ledgers[receiver].append(receiverEnvelope.privateLedgerDraft);
    const chosenRef = (
      receiverEnvelope.proposal.publicArtifact as { objectRef: string }
    ).objectRef;
    const success = chosenRef === targetRef;

    for (const role of [sender, receiver] as const) {
      const adapter = adapters[role];
      await adapter.onOutcome({
        runId: config.runId,
        turn,
        role: role === sender ? 'sender' : 'receiver',
        success,
        reward: success ? 1 : 0,
        payload: [success ? 1 : 0],
      });
      await adapter.updatePolicy?.({
        runId: config.runId,
        turns: [turn],
        learningSignal: config.learningSignal,
      });
    }

    played.push({
      turn,
      sender,
      receiver,
      symbols: [...symbols],
      candidateRefs: [...candidateRefs],
      candidateTypeCodes,
      targetRef,
      targetTypeCode: typeCodes[targetPosition] as number,
      chosenRef,
      success,
    });
  }

  return {
    config,
    symbolInventory,
    events: {
      'baby-a': ledgers['baby-a'].events,
      'baby-b': ledgers['baby-b'].events,
    },
    policies: {
      'baby-a': adapters['baby-a'].exportPolicy(),
      'baby-b': adapters['baby-b'].exportPolicy(),
    },
    episodes: played,
  };
}

/** A minimal schema-valid `LedgerEvent` for hand-built claim fixtures. */
export function ledgerEvent(input: {
  readonly sequence: number;
  readonly turn?: number;
  readonly eventType: string;
  readonly subjectId: string;
  readonly content: Record<string, unknown>;
  readonly babyId?: 'A' | 'B';
}): LedgerEvent {
  const digest = domainHash(
    HASH_DOMAINS.ledgerEntry,
    `fixture/${input.sequence}/${input.eventType}`,
  );
  return {
    version: 1,
    runId: 'run-fixture',
    babyId: input.babyId ?? 'A',
    sequence: input.sequence,
    turn: input.turn ?? input.sequence,
    eventType: input.eventType,
    contentSchema: 'agent-native-ledger',
    subjectId: input.subjectId,
    content: input.content,
    blindingNonce: digest.slice('sha256:'.length, 'sha256:'.length + 24),
    previousEntryHash: `sha256:${'0'.repeat(64)}`,
    recordedAt: new Date(input.sequence * 1_000).toISOString(),
    writerKeyId: 'baby-a-ledger-writer-v1',
    entryHash: digest,
    writerSignature: `ed25519:${Buffer.from(digest).toString('base64')}`,
  };
}

/** A `hypothesis.created` event for form `form` claiming `typeCode`. */
export function claimEvent(input: {
  readonly sequence: number;
  readonly form: string;
  readonly typeCode: number;
  readonly confidence: number;
  readonly version?: number;
  readonly babyId?: 'A' | 'B';
}): LedgerEvent {
  return ledgerEvent({
    sequence: input.sequence,
    eventType: 'hypothesis.created',
    subjectId: `symbol:${input.form}`,
    ...(input.babyId === undefined ? {} : { babyId: input.babyId }),
    content: {
      termRef: `symbol:${input.form}`,
      hypothesisRef: `hyp:${input.form}:${input.version ?? 1}`,
      argmaxTypeCode: input.typeCode,
      confidence: input.confidence,
    },
  });
}

/** An `interpretation.recorded` event that puts `symbols` on the record. */
export function messageEvent(input: {
  readonly sequence: number;
  readonly symbols: readonly string[];
  readonly babyId?: 'A' | 'B';
}): LedgerEvent {
  return ledgerEvent({
    sequence: input.sequence,
    eventType: 'interpretation.recorded',
    subjectId: `artifact:${input.sequence}`,
    ...(input.babyId === undefined ? {} : { babyId: input.babyId }),
    content: {
      artifactRef: `artifact:${input.sequence}`,
      symbols: [...input.symbols],
    },
  });
}
