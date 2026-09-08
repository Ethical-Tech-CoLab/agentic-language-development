/**
 * ALD-033 — the six-display affect protocol (SPECIFICATION.md §9.3, §11.6).
 *
 * Every test runs against a real `SymbolGatewayImpl` over a real
 * `EvidenceWriter`, with no learner adapter involved, so affect rejections go
 * through the one ALD-034 rejection framework (shared counter, shared pause
 * policy, payload hash only).
 */
import { describe, expect, it } from 'vitest';

import {
  AFFECT_DISPLAY_IDS,
  AffectEventSchema,
  GENESIS_HASH,
  type AffectDisplayId,
  type AffectEvent,
  type AffectStateMeasurement,
  type AffectSubmitResult,
  type BabyRole,
  type RunConfig,
} from '@ald/types';
import {
  canonicalJson,
  computeEntryHash,
  omitFields,
  verifyHashSignature,
} from '@ald/hashing';

import {
  AFFECT_ACCEPTED_RESULT_KEYS,
  AFFECT_MEASUREMENT_HASH_DOMAIN,
  AFFECT_REJECTED_RESULT_KEYS,
  AFFECT_VIOLATION_REASON,
  AffectProtocol,
  EMERGENT_AFFECT_ANALYSIS_TAG,
  assertAffectConfiguration,
  normalizedAffectSubmission,
  producesAffectEvents,
  tagEmergentAffect,
  type DerivedAffectResult,
} from '../src/affect.js';
import {
  AffectDisabledError,
  AffectModeMismatchError,
  AffectWindowNotOpenError,
  InvalidAffectWindowError,
  InvalidAffectWindowScheduleError,
  UnknownAffectDerivedMappingError,
} from '../src/affect-errors.js';
import {
  DEFAULT_AFFECT_DERIVED_MAPPING,
  argmaxV1Mapping,
  registeredAffectDerivedMappings,
  resolveAffectDerivedMapping,
} from '../src/affect-mapping.js';
import {
  RECOGNISED_AFFECT_WINDOW_SCHEDULES,
  affectActionAvailable,
  affectWindowDue,
  affectWindowFor,
  affectWindowId,
  createAffectWindow,
  parseAffectWindowSchedule,
} from '../src/affect-windows.js';
import { isGatewayReasonCode } from '../src/reason-codes.js';
import { StepClock } from './fake-evidence-writer.js';
import { harness, intentionDraft, symbolEnvelope, turn } from './support.js';

type AffectHarness = ReturnType<typeof harness>;

/** A run with the affect channel enabled and a window after every turn. */
function affectHarness(
  affectMode: RunConfig['affectMode'],
  overrides: Partial<RunConfig> = {},
): AffectHarness {
  return harness({
    affectMode,
    affectWindowSchedule: 'every-turn',
    ...overrides,
  });
}

/** Opens the scheduled window for one turn and returns it. */
function open(
  h: AffectHarness,
  turnIndex: number,
  sender: BabyRole = 'baby-a',
): ReturnType<typeof createAffectWindow> {
  const recipient: BabyRole = sender === 'baby-a' ? 'baby-b' : 'baby-a';
  return h.gateway.affect.openWindow(
    createAffectWindow({ turn: turnIndex, sender, recipient }),
  );
}

function affectEvents(h: AffectHarness): AffectEvent[] {
  return h.evidence
    .readEvents(h.context.runId, 'affect')
    .map((record) => AffectEventSchema.parse(JSON.parse(record.canonicalJson)));
}

function accepted(
  result: AffectSubmitResult,
): Extract<AffectSubmitResult, { kind: 'accepted' }> {
  if (result.kind !== 'accepted') {
    throw new Error(`expected an accepted affect result, got ${result.kind}`);
  }
  return result;
}

function rejected(
  result: AffectSubmitResult,
): Extract<AffectSubmitResult, { kind: 'rejected' }> {
  if (result.kind !== 'rejected') {
    throw new Error(`expected a rejected affect result, got ${result.kind}`);
  }
  return result;
}

function measurement(scores: number[]): AffectStateMeasurement {
  return {
    measurementVersion: 'v1',
    scores: scores as unknown as AffectStateMeasurement['scores'],
  };
}

// ---------------------------------------------------------------------------
// ALD-033 criterion 1 — declared / permuted / opaque emit only A1-A6
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 1: declared, permuted, and opaque submissions', () => {
  for (const mode of ['declared', 'permuted', 'opaque'] as const) {
    it(`${mode} mode accepts every allowlisted display and records one normalized AffectEvent per window`, async () => {
      const h = affectHarness(mode);
      const keys = h.evidence.signerRegistry.publicKeys();
      const affectKey = keys.find((key) => key.domain === 'affect');

      for (const [index, displayId] of AFFECT_DISPLAY_IDS.entries()) {
        const turnIndex = index + 1;
        const window = open(h, turnIndex);
        const result = accepted(
          await h.gateway.affect.submitAffect(
            window,
            normalizedAffectSubmission(displayId),
          ),
        );

        // SPEC §11.6: the event shape is the schema's, nothing more.
        const event = AffectEventSchema.parse(result.affectEvent);
        expect(event.runId).toBe(h.context.runId);
        expect(event.sequence).toBe(turnIndex);
        expect(event.turn).toBe(turnIndex);
        expect(event.windowId).toBe(affectWindowId(turnIndex, 'baby-a'));
        expect(event.sender).toBe('baby-a');
        expect(event.affectMode).toBe(mode);
        expect(AFFECT_DISPLAY_IDS).toContain(event.displayId);
        expect(Object.keys(result).sort()).toEqual([
          ...AFFECT_ACCEPTED_RESULT_KEYS,
        ]);

        // Real entry hash over the unsigned event, real signature.
        const unsigned = omitFields(event, ['entryHash', 'writerSignature']);
        expect(computeEntryHash('affect', unsigned)).toBe(event.entryHash);
        expect(
          verifyHashSignature(
            event.entryHash,
            event.writerSignature,
            affectKey?.publicKey ?? '',
          ),
        ).toBe(true);
      }

      // LEDGER §4: the affect stream is hash-chained like every other stream.
      const events = affectEvents(h);
      expect(events).toHaveLength(AFFECT_DISPLAY_IDS.length);
      expect(events[0]?.previousEntryHash).toBe(GENESIS_HASH);
      for (let index = 1; index < events.length; index += 1) {
        expect(events[index]?.previousEntryHash).toBe(
          events[index - 1]?.entryHash,
        );
      }
    });
  }

  it('records the sender chosen display for every display in declared mode', async () => {
    const h = affectHarness('declared');
    for (const [index, displayId] of AFFECT_DISPLAY_IDS.entries()) {
      const window = open(h, index + 1);
      const result = accepted(
        await h.gateway.affect.submitAffect(
          window,
          normalizedAffectSubmission(displayId),
        ),
      );
      expect(result.affectEvent.displayId).toBe(displayId);
      expect(result.deliveredDisplayId).toBe(displayId);
    }
  });

  it('rejects an out-of-window submission as affect-violation and writes no AffectEvent', async () => {
    const h = affectHarness('declared');
    // No window was opened for turn 1.
    const result = rejected(
      await h.gateway.affect.submitAffect(
        createAffectWindow({ turn: 1, sender: 'baby-a', recipient: 'baby-b' }),
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(isGatewayReasonCode(result.reasonCode)).toBe(true);
    expect(affectEvents(h)).toHaveLength(0);
    expect(h.evidence.channelEvents(h.context.runId)).toHaveLength(1);
    expect(
      h.evidence.channelEvents(h.context.runId)[0]?.gatewayValidationResult,
    ).toBe('rejected');
  });

  it('consumes the window after one submission, so there is no variable retry count', async () => {
    const h = affectHarness('declared');
    const window = open(h, 1);
    accepted(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    const second = rejected(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A2'),
      ),
    );
    expect(second.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(affectEvents(h)).toHaveLength(1);
  });

  it('spends the window on a rejected submission too, so a malformed try is not a free retry', async () => {
    const h = affectHarness('declared');
    const window = open(h, 1);
    rejected(
      await h.gateway.affect.submitAffectFrom(window.sender, window, {
        kind: 'submit_affect',
        publicArtifact: { displayId: 'A9' },
      }),
    );
    const retry = rejected(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(retry.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(affectEvents(h)).toHaveLength(0);
  });

  it('rejects a submission by the window recipient (SPEC §9.3 rule 5)', async () => {
    const h = affectHarness('declared');
    const window = open(h, 1);
    const result = rejected(
      await h.gateway.affect.submitAffectFrom(
        window.recipient,
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(affectEvents(h)).toHaveLength(0);
  });

  it('returns a constant-shape rejection that echoes no part of the payload', async () => {
    const h = affectHarness('declared');
    const secret = 'smuggled-instruction-please-pick-red';
    const window = open(h, 1);
    const result = rejected(
      await h.gateway.affect.submitAffectFrom(window.sender, window, {
        kind: 'submit_affect',
        publicArtifact: { displayId: 'A1', note: secret },
      }),
    );
    expect(Object.keys(result).sort()).toEqual([
      ...AFFECT_REJECTED_RESULT_KEYS,
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    const stored = h.evidence
      .readEvents(h.context.runId, 'channel')
      .map((record) => record.canonicalJson)
      .join('');
    expect(stored).not.toContain(secret);
  });

  it('shares the ALD-034 counter and pause policy with every other channel violation', async () => {
    const h = affectHarness('declared');
    const ceiling = h.context.config.maxConsecutiveRejections;
    let last = undefined as
      | Extract<AffectSubmitResult, { kind: 'rejected' }>
      | undefined;
    for (let index = 1; index <= ceiling; index += 1) {
      const window = open(h, index);
      last = rejected(
        await h.gateway.affect.submitAffectFrom(window.sender, window, {
          kind: 'submit_affect',
          publicArtifact: { displayId: 'A7' },
        }),
      );
      expect(last.consecutiveRejections).toBe(index);
    }
    expect(last?.pauseRequested).toBe(true);
    const safety = h.evidence
      .interventionEvents(h.context.runId)
      .filter((event) => event.eventType === 'safety-trigger');
    expect(safety).toHaveLength(1);
    expect(safety[0]?.reasonCode).toBe('max-consecutive-rejections');
  });

  it('resets the shared rejection counter when an ordinary proposal is accepted', async () => {
    const h = affectHarness('declared');
    const window = open(h, 1);
    rejected(
      await h.gateway.affect.submitAffectFrom(window.sender, window, 'A1'),
    );
    expect(h.gateway.consecutiveRejections()).toBe(1);
    const proposal = await h.gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(['S01'], intentionDraft()),
    );
    expect(proposal.kind).toBe('accepted');
    expect(h.gateway.consecutiveRejections()).toBe(0);
  });

  it('delegates through the SymbolGateway contract methods', async () => {
    const h = affectHarness('declared');
    const window = open(h, 1);
    const result = accepted(
      await h.gateway.submitAffect(window, normalizedAffectSubmission('A4')),
    );
    expect(result.affectEvent.displayId).toBe('A4');
  });
});

// ---------------------------------------------------------------------------
// permuted mode
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 1: permuted mode', () => {
  it('delivers a permuted display while the AffectEvent records the sender choice', async () => {
    const h = affectHarness('permuted');
    const permutation = h.gateway.affect.researcherOnlyPermutation();
    expect(permutation).toBeDefined();

    for (const [index, displayId] of AFFECT_DISPLAY_IDS.entries()) {
      const window = open(h, index + 1);
      const result = accepted(
        await h.gateway.affect.submitAffect(
          window,
          normalizedAffectSubmission(displayId),
        ),
      );
      expect(result.affectEvent.displayId).toBe(displayId);
      const expected = AFFECT_DISPLAY_IDS[
        (permutation as readonly number[])[index] as number
      ] as AffectDisplayId;
      expect(result.deliveredDisplayId).toBe(expected);
      // Deranged: no display is delivered as itself, so `permuted` is never
      // accidentally `declared`.
      expect(result.deliveredDisplayId).not.toBe(displayId);
    }
  });

  it('derives the permutation from the run seed: reproducible, and different across seeds', () => {
    const first = affectHarness('permuted').gateway.affect.researcherOnlyPermutation();
    const again = affectHarness('permuted').gateway.affect.researcherOnlyPermutation();
    expect(again).toEqual(first);

    const other = harness(
      { affectMode: 'permuted', affectWindowSchedule: 'every-turn' },
      {},
      { seed: 'seed-gateway-999' },
    ).gateway.affect.researcherOnlyPermutation();
    expect(other).not.toEqual(first);
    expect([...(other as readonly number[])].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps the permutation out of every Baby-reachable value', async () => {
    const h = affectHarness('permuted');
    const window = open(h, 1);
    const result = accepted(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    // The only surface carrying the mapping is the researcher-only accessor.
    expect(Object.keys(result).sort()).toEqual([...AFFECT_ACCEPTED_RESULT_KEYS]);
    const serialized = JSON.stringify(result);
    const permutation = h.gateway.affect.researcherOnlyPermutation();
    expect(serialized).not.toContain(JSON.stringify(permutation));
    // A single accepted window reveals exactly one (chosen, delivered) pair.
    expect(Object.keys(result.affectEvent).sort()).toEqual(
      Object.keys(AffectEventSchema.parse(result.affectEvent)).sort(),
    );
  });

  it('returns a defensive copy of the researcher-only permutation', () => {
    const h = affectHarness('permuted');
    const first = h.gateway.affect.researcherOnlyPermutation() as number[];
    first[0] = 99;
    expect(h.gateway.affect.researcherOnlyPermutation()?.[0]).not.toBe(99);
  });

  it('exposes no permutation in declared or opaque mode', () => {
    expect(
      affectHarness('declared').gateway.affect.researcherOnlyPermutation(),
    ).toBeUndefined();
    expect(
      affectHarness('opaque').gateway.affect.researcherOnlyPermutation(),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// opaque mode
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 1: opaque mode', () => {
  it('behaves identically to declared on the wire, differing only in the recorded affectMode', async () => {
    async function run(mode: RunConfig['affectMode']): Promise<AffectEvent[]> {
      const h = affectHarness(mode);
      for (const [index, displayId] of AFFECT_DISPLAY_IDS.entries()) {
        const window = open(h, index + 1);
        accepted(
          await h.gateway.affect.submitAffect(
            window,
            normalizedAffectSubmission(displayId),
          ),
        );
      }
      return affectEvents(h);
    }

    const declared = await run('declared');
    const opaque = await run('opaque');
    expect(opaque).toHaveLength(declared.length);
    for (let index = 0; index < declared.length; index += 1) {
      const a = declared[index] as AffectEvent;
      const b = opaque[index] as AffectEvent;
      expect(b.affectMode).toBe('opaque');
      expect(a.affectMode).toBe('declared');
      // Everything the recipient could observe is identical; only the recorded
      // mode label (and therefore the entry hash and signature) differs.
      expect(b.displayId).toBe(a.displayId);
      expect(b.windowId).toBe(a.windowId);
      expect(b.sender).toBe(a.sender);
      expect(b.turn).toBe(a.turn);
      expect(b.sequence).toBe(a.sequence);
    }
  });
});

// ---------------------------------------------------------------------------
// ALD-033 criterion 2 — derived mode
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 2: derived mode', () => {
  it('disables submit_affect and rejects even a well-formed submission', async () => {
    const h = affectHarness('derived');
    const window = open(h, 1);
    expect(h.gateway.affect.affectActionAvailable()).toBe(false);
    const result = rejected(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(affectEvents(h)).toHaveLength(0);
    // The rogue submission does not spend the Gateway's own derived window.
    const derived = (await h.gateway.recordDerivedAffect(
      window,
      measurement([0, 0, 1, 0, 0, 0]),
    )) as DerivedAffectResult;
    expect(derived.kind).toBe('accepted');
  });

  it('records the complete private measurement and applies the pre-registered mapping', async () => {
    const h = affectHarness('derived');
    const window = open(h, 1);
    const scores = [0.1, 0.2, 0.9, 0.4, 0.5, 0.6];
    const result = (await h.gateway.recordDerivedAffect(
      window,
      measurement(scores),
    )) as DerivedAffectResult;
    const ok = accepted(result);
    expect(ok.affectEvent.affectMode).toBe('derived');
    expect(ok.affectEvent.displayId).toBe('A3');
    expect(ok.deliveredDisplayId).toBe('A3');

    const record = result.privateMeasurement;
    expect(record?.mapping).toBe(DEFAULT_AFFECT_DERIVED_MAPPING);
    expect(record?.measurement.scores).toEqual(scores);
    expect(record?.measurementHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(h.gateway.affect.privateMeasurementFor(window.windowId)).toEqual(
      record,
    );

    // The measurement never reaches the public event or the affect stream.
    const stored = h.evidence
      .readEvents(h.context.runId, 'affect')
      .map((record_) => record_.canonicalJson)
      .join('');
    expect(stored).not.toContain('scores');
    expect(stored).not.toContain('0.9');
    expect(JSON.stringify(ok.affectEvent)).not.toContain('scores');
  });

  it('resolves argmax-v1 ties to the lowest display index', () => {
    expect(argmaxV1Mapping.map(measurement([1, 1, 1, 1, 1, 1]))).toBe('A1');
    expect(argmaxV1Mapping.map(measurement([0, 2, 2, 0, 0, 0]))).toBe('A2');
    expect(argmaxV1Mapping.map(measurement([-3, -3, -3, -3, -3, -1]))).toBe('A6');
    expect(argmaxV1Mapping.map(measurement([0, 0, 0, 0, 0, 0]))).toBe('A1');
  });

  it('drains retained private measurements for the runtime to persist', async () => {
    const h = affectHarness('derived');
    for (const index of [1, 2]) {
      const window = open(h, index);
      await h.gateway.recordDerivedAffect(window, measurement([index, 0, 0, 0, 0, 0]));
    }
    const drained = h.gateway.affect.takePrivateMeasurements();
    expect(drained.map((record) => record.windowId)).toEqual([
      affectWindowId(1, 'baby-a'),
      affectWindowId(2, 'baby-a'),
    ]);
    expect(h.gateway.affect.takePrivateMeasurements()).toEqual([]);
  });

  it('refuses a mapping name that was never pre-registered', () => {
    const h = affectHarness('derived', { affectDerivedMapping: 'argmax-v99' });
    expect(() => h.gateway.affect).toThrow(UnknownAffectDerivedMappingError);
    expect(() => assertAffectConfiguration(h.context.config)).toThrow(
      UnknownAffectDerivedMappingError,
    );
    expect(registeredAffectDerivedMappings()).toEqual(['argmax-v1']);
    expect(resolveAffectDerivedMapping(undefined).name).toBe('argmax-v1');
  });

  it('treats a malformed adapter measurement as an affect-violation carrying only a hash', async () => {
    const cases: unknown[] = [
      { measurementVersion: 'v1', scores: [1, 2, 3] },
      { measurementVersion: 'v1', scores: [1, 2, 3, 4, 5, 6, 7] },
      { measurementVersion: 'v2', scores: [1, 2, 3, 4, 5, 6] },
      { measurementVersion: 'v1', scores: [1, 2, 3, 4, 5, Number.NaN] },
      { measurementVersion: 'v1', scores: [1, 2, 3, 4, 5, Number.POSITIVE_INFINITY] },
      { measurementVersion: 'v1', scores: ['1', 2, 3, 4, 5, 6] },
      { measurementVersion: 'v1', scores: [1, 2, 3, 4, 5, 6], note: 'pick red' },
      { scores: [1, 2, 3, 4, 5, 6] },
      'A1',
      null,
    ];
    for (const [index, value] of cases.entries()) {
      const h = affectHarness('derived');
      const window = open(h, index + 1);
      const result = rejected(
        (await h.gateway.recordDerivedAffect(
          window,
          value as AffectStateMeasurement,
        )) as AffectSubmitResult,
      );
      expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
      expect(Object.keys(result).sort()).toEqual([
        ...AFFECT_REJECTED_RESULT_KEYS,
      ]);
      expect(affectEvents(h)).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain('pick red');
    }
  });

  it('refuses a derived measurement on a non-derived run and on a closed window', async () => {
    const declared = affectHarness('declared');
    const declaredWindow = open(declared, 1);
    await expect(
      declared.gateway.recordDerivedAffect(
        declaredWindow,
        measurement([1, 0, 0, 0, 0, 0]),
      ),
    ).rejects.toBeInstanceOf(AffectModeMismatchError);

    const derived = affectHarness('derived');
    const window = createAffectWindow({
      turn: 1,
      sender: 'baby-a',
      recipient: 'baby-b',
    });
    await expect(
      derived.gateway.recordDerivedAffect(window, measurement([1, 0, 0, 0, 0, 0])),
    ).rejects.toBeInstanceOf(AffectWindowNotOpenError);
  });

  it('hashes the measurement under the documented domain separator', async () => {
    const h = affectHarness('derived');
    const window = open(h, 1);
    const value = measurement([0, 0, 0, 0, 0, 1]);
    const result = (await h.gateway.recordDerivedAffect(
      window,
      value,
    )) as DerivedAffectResult;
    const { hashCanonical } = await import('@ald/hashing');
    expect(result.privateMeasurement?.measurementHash).toBe(
      hashCanonical(AFFECT_MEASUREMENT_HASH_DOMAIN, value),
    );
  });
});

// ---------------------------------------------------------------------------
// ALD-033 criterion 2 — emergent mode
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 2: emergent mode', () => {
  it('produces no AffectEvent and records the display as an ordinary ChannelEvent', async () => {
    const h = affectHarness('emergent');
    expect(producesAffectEvents('emergent')).toBe(false);
    expect(producesAffectEvents('none')).toBe(false);

    const window = open(h, 1);
    const result = rejected(
      await h.gateway.affect.submitAffect(
        window,
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(result.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(affectEvents(h)).toHaveLength(0);

    // The carrier channel event is the only record; the tag is analysis-side.
    const submitted = await h.gateway.submitProposal(
      turn({ turn: 2 }),
      symbolEnvelope(['S05']),
    );
    if (submitted.kind !== 'accepted') {
      throw new Error('expected the carrier proposal to be accepted');
    }
    const tag = tagEmergentAffect(submitted.channelEvent);
    expect(tag).toEqual({
      analysisTag: EMERGENT_AFFECT_ANALYSIS_TAG,
      channelEventHash: submitted.channelEvent.entryHash,
      turn: 2,
      sender: 'baby-a',
    });
    // Tagging never touches the signed event.
    expect(Object.keys(submitted.channelEvent)).not.toContain('analysisTag');
    expect(affectEvents(h)).toHaveLength(0);
  });

  it('refuses a derived measurement in emergent mode', async () => {
    const h = affectHarness('emergent');
    const window = open(h, 1);
    await expect(
      h.gateway.recordDerivedAffect(window, measurement([1, 0, 0, 0, 0, 0])),
    ).rejects.toBeInstanceOf(AffectModeMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Window schedule and availability (SPEC §9.3 rules 2 and 5, §6.3)
// ---------------------------------------------------------------------------

describe('ALD-033: fixed window schedule', () => {
  it('parses the recognised schedules and refuses everything else', () => {
    expect(parseAffectWindowSchedule('every-turn').everyTurns).toBe(1);
    expect(parseAffectWindowSchedule('every-4-turns').everyTurns).toBe(4);
    expect(parseAffectWindowSchedule('never').everyTurns).toBeUndefined();
    for (const bad of [
      'every-0-turns',
      'every-4-turn',
      'sometimes',
      '',
      'EVERY-TURN',
      'every--turns',
      'every-4-turns ',
    ]) {
      expect(() => parseAffectWindowSchedule(bad)).toThrow(
        InvalidAffectWindowScheduleError,
      );
    }
    expect(RECOGNISED_AFFECT_WINDOW_SCHEDULES).toContain('every-<n>-turns');
  });

  it('opens a window only on scheduled turns', () => {
    const schedule = parseAffectWindowSchedule('every-4-turns');
    expect(affectWindowDue(schedule, 0)).toBe(false);
    expect(affectWindowDue(schedule, 3)).toBe(false);
    expect(affectWindowDue(schedule, 4)).toBe(true);
    expect(affectWindowDue(schedule, 8)).toBe(true);
    expect(affectWindowDue(parseAffectWindowSchedule('never'), 4)).toBe(false);
    expect(
      affectWindowFor({
        schedule,
        turn: 3,
        sender: 'baby-a',
        recipient: 'baby-b',
      }),
    ).toBeUndefined();
    expect(
      affectWindowFor({
        schedule,
        turn: 4,
        sender: 'baby-b',
        recipient: 'baby-a',
      }),
    ).toEqual({
      windowId: 'w-4-baby-b',
      turn: 4,
      sender: 'baby-b',
      recipient: 'baby-a',
      opensAfter: 'outcome',
    });
  });

  it('refuses an extra window the schedule does not allow, and a reopened window', () => {
    const h = affectHarness('declared', { affectWindowSchedule: 'every-4-turns' });
    expect(() => open(h, 3)).toThrow(InvalidAffectWindowError);
    open(h, 4);
    expect(() => open(h, 4)).toThrow(InvalidAffectWindowError);
  });

  it('closes the previous window when the next one opens', async () => {
    const h = affectHarness('declared');
    const first = open(h, 1);
    open(h, 2);
    const late = rejected(
      await h.gateway.affect.submitAffect(
        first,
        normalizedAffectSubmission('A1'),
      ),
    );
    expect(late.reasonCode).toBe(AFFECT_VIOLATION_REASON);
    expect(h.gateway.affect.openWindowState()?.turn).toBe(2);
  });

  it('rejects a malformed window outright rather than committing a rejection', () => {
    for (const bad of [
      { windowId: '', turn: 1, sender: 'baby-a', recipient: 'baby-b', opensAfter: 'outcome' },
      { windowId: 'w-1-baby-a', turn: -1, sender: 'baby-a', recipient: 'baby-b', opensAfter: 'outcome' },
      { windowId: 'w-1-baby-a', turn: 1, sender: 'baby-a', recipient: 'baby-a', opensAfter: 'outcome' },
      { windowId: 'w-1-baby-a', turn: 1, sender: 'baby-a', recipient: 'baby-b', opensAfter: 'action' },
      { windowId: 'w-9-baby-a', turn: 1, sender: 'baby-a', recipient: 'baby-b', opensAfter: 'outcome' },
    ]) {
      const h = affectHarness('declared');
      expect(() =>
        h.gateway.affect.openWindow(
          bad as unknown as ReturnType<typeof createAffectWindow>,
        ),
      ).toThrow(InvalidAffectWindowError);
    }
  });

  it('offers submit_affect only in the three submission modes and only inside a window', () => {
    for (const mode of ['declared', 'permuted', 'opaque'] as const) {
      expect(affectActionAvailable(mode, true)).toBe(true);
      expect(affectActionAvailable(mode, false)).toBe(false);
    }
    for (const mode of ['none', 'derived', 'emergent'] as const) {
      expect(affectActionAvailable(mode, true)).toBe(false);
      expect(affectActionAvailable(mode, false)).toBe(false);
    }

    const h = affectHarness('declared');
    expect(h.gateway.affect.affectActionAvailable()).toBe(false);
    open(h, 1);
    expect(h.gateway.affect.affectActionAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALD-033 criterion 3 — normalized envelope behaviour, disabled runs
// ---------------------------------------------------------------------------

describe('ALD-033 criterion 3: normalized envelope and configuration', () => {
  it('gives every one of the six submissions the same canonical byte length', () => {
    const lengths = new Set(
      AFFECT_DISPLAY_IDS.map(
        (displayId) =>
          Buffer.byteLength(
            canonicalJson(normalizedAffectSubmission(displayId)),
            'utf8',
          ),
      ),
    );
    expect(lengths.size).toBe(1);
  });

  it('keeps the accepted and rejected result key sets constant across modes and violations', async () => {
    const violations: unknown[] = [
      'A1',
      { kind: 'submit_affect', publicArtifact: { displayId: ['A1', 'A1'] } },
      { kind: 'submit_affect', publicArtifact: { displayId: 'A9' } },
      { kind: 'emit_symbols', publicArtifact: { symbols: ['S01'] } },
    ];
    for (const mode of ['declared', 'permuted', 'opaque'] as const) {
      for (const [index, payload] of violations.entries()) {
        const h = affectHarness(mode);
        const window = open(h, index + 1);
        const result = rejected(
          await h.gateway.affect.submitAffectFrom(window.sender, window, payload),
        );
        expect(Object.keys(result).sort()).toEqual([
          ...AFFECT_REJECTED_RESULT_KEYS,
        ]);
      }
      const h = affectHarness(mode);
      const window = open(h, 1);
      const ok = accepted(
        await h.gateway.affect.submitAffect(
          window,
          normalizedAffectSubmission('A1'),
        ),
      );
      expect(Object.keys(ok).sort()).toEqual([...AFFECT_ACCEPTED_RESULT_KEYS]);
    }
  });

  it('has no affect surface at all when the channel is disabled', () => {
    const h = harness({ affectMode: 'none' });
    expect(() => h.gateway.affect).toThrow(AffectDisabledError);
    expect(() => assertAffectConfiguration(h.context.config)).not.toThrow();
    expect(producesAffectEvents('none')).toBe(false);
  });

  it('validates the whole affect configuration before turn 1', () => {
    const h = affectHarness('declared', { affectWindowSchedule: 'occasionally' });
    expect(() => assertAffectConfiguration(h.context.config)).toThrow(
      InvalidAffectWindowScheduleError,
    );
    expect(() =>
      assertAffectConfiguration(
        affectHarness('derived').context.config,
      ),
    ).not.toThrow();
  });

  it('takes the AffectEvent timestamp from the injected clock', async () => {
    const h = affectHarness('declared');
    const clock = new StepClock(Date.UTC(2026, 5, 1, 12, 0, 0), 1000);
    const protocol = new AffectProtocol({
      runContext: h.context,
      evidence: h.evidence,
      commitAffectRejection: () => {
        throw new Error('this test exercises the accepted path only');
      },
      now: () => clock.now(),
    });
    const window = protocol.openWindow(
      createAffectWindow({ turn: 1, sender: 'baby-a', recipient: 'baby-b' }),
    );
    const result = accepted(
      await protocol.submitAffect(window, normalizedAffectSubmission('A2')),
    );
    expect(result.affectEvent.deliveredAt).toBe('2026-06-01T12:00:00.000Z');
  });
});
