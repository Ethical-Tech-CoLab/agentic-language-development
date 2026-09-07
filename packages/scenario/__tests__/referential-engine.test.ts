import { describe, expect, it } from 'vitest';

import {
  HASH_DOMAINS,
  fixedTokenInventory,
  type AgentActionProposal,
  type BabyRole,
  type ScenarioInstance,
  type ScenarioSplit,
} from '@ald/types';
import { SeededPrng, canonicalJson, hashCanonical } from '@ald/hashing';

import {
  HygieneViolationError,
  ReferentialScenarioEngine,
  ScenarioEngineError,
  readGroundTruth,
  zoneOfPossibleAgreement,
  type ReferentialScenarioConfigInput,
} from '../src/index.js';

const ROLES: { sender: BabyRole; receiver: BabyRole } = {
  sender: 'baby-a',
  receiver: 'baby-b',
};
const RUN_SEED = 'ald-e03-v1-slot-7';
const INVENTORY_32 = fixedTokenInventory(32);

function engine(
  overrides: Partial<ReferentialScenarioConfigInput> = {},
  runSeed = RUN_SEED,
): ReferentialScenarioEngine {
  return new ReferentialScenarioEngine(
    { version: 1, symbolInventory: INVENTORY_32, ...overrides },
    runSeed,
  );
}

function selectAction(objectRef: string): AgentActionProposal {
  return { kind: 'select_object', publicArtifact: { objectRef } };
}

describe('ReferentialScenarioEngine configuration', () => {
  it('applies the RESEARCH.md Appendix D defaults', () => {
    const scenario = engine();
    expect(scenario.config.attributeCount).toBe(2);
    expect(scenario.config.valuesPerAttribute).toBe(4);
    expect(scenario.config.candidatesPerEpisode).toBe(4);
    expect(scenario.config.heldOutTypeCodes).toEqual([]);
    expect(scenario.config.interactionMode).toBe('cooperative-signaling');
    expect(scenario.typeCodeCount).toBe(16);
    expect(scenario.chanceSuccessRate).toBe(0.25);
  });

  it('binds bundleHash to the resolved config under the scenario-bundle domain', () => {
    const scenario = engine();
    expect(scenario.bundleHash).toBe(
      hashCanonical(HASH_DOMAINS.scenarioBundle, scenario.config),
    );
    expect(engine().bundleHash).toBe(scenario.bundleHash);
    expect(engine({ candidatesPerEpisode: 8 }).bundleHash).not.toBe(
      scenario.bundleHash,
    );
    expect(engine({ interactionMode: 'conflicting-negotiation' }).bundleHash).not.toBe(
      scenario.bundleHash,
    );
  });

  it('rejects configurations it cannot generate', () => {
    expect(() => engine({ candidatesPerEpisode: 32 })).toThrow(ScenarioEngineError);
    expect(() => engine({ symbolInventory: ['S01'] })).toThrow(ScenarioEngineError);
    expect(() => engine({ symbolInventory: ['S01', 'S01'] })).toThrow(
      ScenarioEngineError,
    );
    expect(() => engine({ heldOutTypeCodes: [16] })).toThrow(ScenarioEngineError);
    expect(() =>
      engine({ heldOutTypeCodes: Array.from({ length: 16 }, (_, index) => index) }),
    ).toThrow(ScenarioEngineError);
    expect(() => engine({ attributeCount: 0 })).toThrow(ScenarioEngineError);
    expect(() => engine({}, '')).toThrow(ScenarioEngineError);
  });

  it('rejects a same-Baby role pair and a negative episode index', () => {
    const scenario = engine();
    expect(() =>
      scenario.generate(0, 'train', { sender: 'baby-a', receiver: 'baby-a' }),
    ).toThrow(ScenarioEngineError);
    expect(() => scenario.generate(-1, 'train', ROLES)).toThrow(ScenarioEngineError);
  });
});

describe('determinism (ALD-041 criterion 1)', () => {
  it('produces byte-identical episodes 0..50 across two engine instances', () => {
    const left = engine();
    const right = engine();
    for (let episode = 0; episode <= 50; episode += 1) {
      for (const split of ['train', 'held-out', 'evaluation'] as ScenarioSplit[]) {
        expect(canonicalJson(right.generate(episode, split, ROLES))).toBe(
          canonicalJson(left.generate(episode, split, ROLES)),
        );
      }
    }
  });

  it('produces different episodes for a different run seed', () => {
    const left = engine();
    const right = engine({}, 'ald-e03-v1-slot-8');
    let differences = 0;
    for (let episode = 0; episode <= 50; episode += 1) {
      if (
        canonicalJson(left.generate(episode, 'train', ROLES)) !==
        canonicalJson(right.generate(episode, 'train', ROLES))
      ) {
        differences += 1;
      }
    }
    expect(differences).toBe(51);
  });

  it('separates the splits and the evaluation seed label', () => {
    const scenario = engine();
    expect(canonicalJson(scenario.generate(3, 'train', ROLES))).not.toBe(
      canonicalJson(scenario.generate(3, 'evaluation', ROLES)),
    );
    const labelled = engine({ evaluationSeedLabel: 'batch-2' });
    expect(canonicalJson(labelled.generate(3, 'evaluation', ROLES))).not.toBe(
      canonicalJson(scenario.generate(3, 'evaluation', ROLES)),
    );
    // The label only reaches the evaluation split.
    expect(canonicalJson(labelled.generate(3, 'train', ROLES))).toBe(
      canonicalJson(scenario.generate(3, 'train', ROLES)),
    );
  });

  it('binds stateHash to scenarioRef, ground truth, and observations', () => {
    const instance = engine().generate(11, 'train', ROLES);
    expect(instance.stateHash).toBe(
      hashCanonical(HASH_DOMAINS.scenarioState, {
        scenarioRef: instance.scenarioRef,
        groundTruth: instance.groundTruth,
        observations: instance.observations,
      }),
    );
  });
});

describe('episode structure', () => {
  it('mints opaque, non-descriptive references', () => {
    const scenario = engine();
    for (let episode = 0; episode < 100; episode += 1) {
      const instance = scenario.generate(episode, 'train', ROLES);
      expect(instance.scenarioRef).toMatch(/^scn:[a-f0-9]{16}$/u);
      expect(instance.candidateRefs).toHaveLength(4);
      expect(new Set(instance.candidateRefs).size).toBe(4);
      for (const ref of instance.candidateRefs) {
        expect(ref).toMatch(/^o:[a-f0-9]{12}$/u);
      }
      const truth = readGroundTruth(instance.groundTruth);
      expect(instance.candidateRefs).toContain(truth.targetRef);
    }
  });

  it('draws distinct candidate type codes and consistent orders', () => {
    const scenario = engine();
    for (let episode = 0; episode < 100; episode += 1) {
      const truth = readGroundTruth(
        scenario.generate(episode, 'train', ROLES).groundTruth,
      );
      expect(new Set(truth.senderOrder).size).toBe(4);
      expect([...truth.senderOrder].sort()).toEqual([...truth.receiverOrder].sort());
      expect(truth.senderOrder).toContain(truth.targetTypeCode);
    }
  });

  it('builds numeric-only observations in the SPEC §10.1 shape', () => {
    const instance = engine().generate(5, 'train', ROLES);
    const truth = readGroundTruth(instance.groundTruth);
    const senderRows = instance.observations['baby-a'] as number[][];
    const receiverRows = instance.observations['baby-b'] as number[][];

    expect(senderRows).toHaveLength(4);
    expect(receiverRows).toHaveLength(4);
    senderRows.forEach((row, index) => {
      const code = truth.senderOrder[index] as number;
      expect(row).toEqual([
        ...(truth.attributeCodes[String(code)] as number[]),
        code === truth.targetTypeCode ? 1 : 0,
      ]);
    });
    receiverRows.forEach((row, index) => {
      const code = truth.receiverOrder[index] as number;
      expect(row).toEqual(truth.attributeCodes[String(code)]);
    });
    // The receiver never sees a target column.
    expect(receiverRows.every((row) => row.length === 2)).toBe(true);
    expect(senderRows.filter((row) => row[2] === 1)).toHaveLength(1);
  });

  it('keeps the receiver order independent of the target position', () => {
    const scenario = engine();
    const counts = [0, 0, 0, 0];
    const episodes = 2_000;
    for (let episode = 0; episode < episodes; episode += 1) {
      const instance = scenario.generate(episode, 'evaluation', ROLES);
      const truth = readGroundTruth(instance.groundTruth);
      const index = instance.candidateRefs.indexOf(truth.targetRef);
      counts[index] = (counts[index] as number) + 1;
    }
    for (const count of counts) {
      expect(count / episodes).toBeGreaterThanOrEqual(0.2);
      expect(count / episodes).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('held-out rule', () => {
  const heldOutTypeCodes = [0, 3, 7, 12];
  const scenario = engine({ heldOutTypeCodes });

  it('never targets a held-out type in the train split', () => {
    for (let episode = 0; episode < 500; episode += 1) {
      const truth = readGroundTruth(
        scenario.generate(episode, 'train', ROLES).groundTruth,
      );
      expect(heldOutTypeCodes).not.toContain(truth.targetTypeCode);
    }
  });

  it('only targets held-out types in the held-out split', () => {
    for (let episode = 0; episode < 500; episode += 1) {
      const truth = readGroundTruth(
        scenario.generate(episode, 'held-out', ROLES).groundTruth,
      );
      expect(heldOutTypeCodes).toContain(truth.targetTypeCode);
    }
  });

  it('draws evaluation targets from every type code', () => {
    const seen = new Set<number>();
    for (let episode = 0; episode < 500; episode += 1) {
      seen.add(
        readGroundTruth(scenario.generate(episode, 'evaluation', ROLES).groundTruth)
          .targetTypeCode,
      );
    }
    expect(seen.size).toBe(16);
    for (const code of heldOutTypeCodes) {
      expect(seen.has(code)).toBe(true);
    }
  });

  it('targets every type code in the held-out split when nothing is held out', () => {
    const open = engine();
    const seen = new Set<number>();
    for (let episode = 0; episode < 500; episode += 1) {
      seen.add(
        readGroundTruth(open.generate(episode, 'held-out', ROLES).groundTruth)
          .targetTypeCode,
      );
    }
    expect(seen.size).toBe(16);
  });
});

describe('chance baseline (SPEC §15.3, RESEARCH.md Appendix D)', () => {
  it('scores a seeded uniform selector inside [0.22, 0.28] over 4000 episodes', () => {
    const scenario = engine();
    const picker = new SeededPrng('uniform-selector').derive('e03');
    const episodes = 4_000;
    let successes = 0;
    for (let episode = 0; episode < episodes; episode += 1) {
      const instance = scenario.generate(episode, 'evaluation', ROLES);
      const choice = instance.candidateRefs[
        picker.nextInt(instance.candidateRefs.length)
      ] as string;
      const outcome = scenario.evaluate(instance, selectAction(choice));
      successes += outcome.success ? 1 : 0;
      expect(outcome.reward).toBe(outcome.success ? 1 : 0);
    }
    const rate = successes / episodes;
    expect(rate).toBeGreaterThanOrEqual(0.22);
    expect(rate).toBeLessThanOrEqual(0.28);
    expect(scenario.chanceSuccessRate).toBe(0.25);
  });

  it('scores a position-only selector at chance too', () => {
    const scenario = engine();
    const episodes = 2_000;
    let successes = 0;
    for (let episode = 0; episode < episodes; episode += 1) {
      const instance = scenario.generate(episode, 'evaluation', ROLES);
      successes += scenario.evaluate(
        instance,
        selectAction(instance.candidateRefs[0] as string),
      ).success
        ? 1
        : 0;
    }
    const rate = successes / episodes;
    expect(rate).toBeGreaterThanOrEqual(0.2);
    expect(rate).toBeLessThanOrEqual(0.3);
  });
});

describe('evaluate', () => {
  const scenario = engine();
  const instance = scenario.generate(9, 'train', ROLES);
  const truth = readGroundTruth(instance.groundTruth);

  it('rewards the target and only the target', () => {
    const outcome = scenario.evaluate(instance, selectAction(truth.targetRef));
    expect(outcome).toMatchObject({ success: true, reward: 1 });
    expect(outcome.details).toEqual({
      selectedRef: truth.targetRef,
      targetRef: truth.targetRef,
      selectedTypeCode: truth.targetTypeCode,
      targetTypeCode: truth.targetTypeCode,
    });

    const distractor = instance.candidateRefs.find(
      (ref) => ref !== truth.targetRef,
    ) as string;
    const miss = scenario.evaluate(instance, selectAction(distractor));
    expect(miss.success).toBe(false);
    expect(miss.reward).toBe(0);
    expect(miss.details.selectedTypeCode).not.toBe(truth.targetTypeCode);
  });

  it('rejects a reference that is not a candidate', () => {
    const outcome = scenario.evaluate(instance, selectAction('o:deadbeef1234'));
    expect(outcome.success).toBe(false);
    expect(outcome.reward).toBe(0);
    expect(outcome.details.reason).toBe('invalid-selection');
    expect(outcome.details.selectedRef).toBe('o:deadbeef1234');
  });

  it('rejects an action that is not select_object', () => {
    const outcome = scenario.evaluate(instance, {
      kind: 'emit_symbols',
      publicArtifact: { symbols: ['S01'] },
    });
    expect(outcome.success).toBe(false);
    expect(outcome.reward).toBe(0);
    expect(outcome.details.reason).toBe('invalid-selection');
    expect(outcome.details.actionKind).toBe('emit_symbols');
  });

  it('refuses ground truth it did not produce', () => {
    const foreign = { ...instance, groundTruth: { targetRef: 'o:0' } };
    expect(() =>
      scenario.evaluate(foreign as ScenarioInstance, selectAction('o:0')),
    ).toThrow(ScenarioEngineError);
  });
});

describe('oracle control (SPEC §9.6)', () => {
  it('solves 500 episodes with a 32-symbol inventory in one symbol', () => {
    const scenario = engine();
    expect(scenario.symbolWidth).toBe(1);
    for (let episode = 0; episode < 500; episode += 1) {
      const instance = scenario.generate(episode, 'evaluation', ROLES);
      const artifact = scenario.oracleArtifact(instance);
      expect('symbols' in artifact ? artifact.symbols : []).toHaveLength(1);
      const action = scenario.oracleAction(instance, artifact);
      expect(action.kind).toBe('select_object');
      expect(scenario.evaluate(instance, action).success).toBe(true);
    }
  });

  it('solves 500 episodes with a 4-symbol inventory in two symbols', () => {
    const scenario = engine({ symbolInventory: fixedTokenInventory(4) });
    expect(scenario.symbolWidth).toBe(2);
    for (let episode = 0; episode < 500; episode += 1) {
      const instance = scenario.generate(episode, 'evaluation', ROLES);
      const artifact = scenario.oracleArtifact(instance);
      expect('symbols' in artifact ? artifact.symbols : []).toHaveLength(2);
      expect(scenario.evaluate(instance, scenario.oracleAction(instance, artifact))
        .success).toBe(true);
    }
  });

  it('round-trips every type code through the symbol encoding', () => {
    for (const size of [2, 4, 5, 32]) {
      const scenario = engine({ symbolInventory: fixedTokenInventory(size) });
      for (let code = 0; code < scenario.typeCodeCount; code += 1) {
        const symbols = scenario.encodeTypeCode(code);
        expect(symbols).toHaveLength(scenario.symbolWidth);
        expect(scenario.decodeTypeCode(symbols)).toBe(code);
      }
    }
  });

  it('throws when the artifact does not decode to a present candidate', () => {
    const scenario = engine();
    const instance = scenario.generate(2, 'train', ROLES);
    const truth = readGroundTruth(instance.groundTruth);
    const absent = Array.from({ length: 16 }, (_, code) => code).find(
      (code) => !truth.senderOrder.includes(code),
    ) as number;

    expect(() =>
      scenario.oracleAction(instance, { symbols: scenario.encodeTypeCode(absent) }),
    ).toThrow(ScenarioEngineError);
    expect(() => scenario.oracleAction(instance, { symbols: ['NOPE'] })).toThrow(
      ScenarioEngineError,
    );
    expect(() =>
      scenario.oracleAction(instance, { symbols: ['S01', 'S02'] }),
    ).toThrow(ScenarioEngineError);
    expect(() =>
      scenario.oracleAction(instance, { objectRef: truth.targetRef }),
    ).toThrow(ScenarioEngineError);
  });
});

describe('interaction profiles (SPEC §9.5)', () => {
  it('generates every profile', () => {
    for (const interactionMode of [
      'cooperative-signaling',
      'asymmetric-information',
      'semi-cooperative-negotiation',
      'conflicting-negotiation',
      'no-agreement-control',
    ] as const) {
      const scenario = engine({ interactionMode });
      for (let episode = 0; episode < 20; episode += 1) {
        const instance = scenario.generate(episode, 'train', ROLES);
        expect(instance.interactionMode).toBe(interactionMode);
        expect(instance.candidateRefs).toHaveLength(4);
      }
    }
  });

  it('asymmetric-information shows the receiver only the first attribute', () => {
    const scenario = engine({
      interactionMode: 'asymmetric-information',
      attributeCount: 3,
      valuesPerAttribute: 3,
    });
    for (let episode = 0; episode < 50; episode += 1) {
      const instance = scenario.generate(episode, 'train', ROLES);
      const truth = readGroundTruth(instance.groundTruth);
      expect(truth.receiverVisibleAttributeCount).toBe(1);
      const senderRows = instance.observations['baby-a'] as number[][];
      const receiverRows = instance.observations['baby-b'] as number[][];
      senderRows.forEach((row) => {
        expect(row).toHaveLength(4);
      });
      receiverRows.forEach((row, index) => {
        const code = truth.receiverOrder[index] as number;
        expect(row).toEqual([
          (truth.attributeCodes[String(code)] as number[])[0] as number,
        ]);
      });
    }
  });

  it('semi-cooperative-negotiation always has a non-empty zone of agreement', () => {
    const scenario = engine({ interactionMode: 'semi-cooperative-negotiation' });
    for (let episode = 0; episode < 300; episode += 1) {
      const instance = scenario.generate(episode, 'train', ROLES);
      const truth = readGroundTruth(instance.groundTruth);
      const zone = zoneOfPossibleAgreement(truth);
      expect(zone.length).toBeGreaterThan(0);
      expect(truth.zopaRefs).toEqual(zone);
      for (const ref of zone) {
        expect(instance.candidateRefs).toContain(ref);
      }
      for (const role of ['baby-a', 'baby-b'] as BabyRole[]) {
        for (const code of truth.senderOrder) {
          const utility = truth.utilities?.[role][String(code)] as number;
          expect(utility).toBeGreaterThanOrEqual(1);
          expect(utility).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it('no-agreement-control has a provably empty zone of agreement', () => {
    const scenario = engine({ interactionMode: 'no-agreement-control' });
    for (let episode = 0; episode < 300; episode += 1) {
      const truth = readGroundTruth(
        scenario.generate(episode, 'train', ROLES).groundTruth,
      );
      expect(zoneOfPossibleAgreement(truth)).toEqual([]);
      expect(truth.zopaRefs).toEqual([]);
      // At least one Baby's reservation is strictly above every utility.
      const blocked = (['baby-a', 'baby-b'] as BabyRole[]).some((role) =>
        truth.senderOrder.every(
          (code) =>
            (truth.utilities?.[role][String(code)] as number) <
            (truth.reservations?.[role] as number),
        ),
      );
      expect(blocked).toBe(true);
    }
  });

  it('conflicting-negotiation opposes the utilities and leaves agreement open', () => {
    const scenario = engine({ interactionMode: 'conflicting-negotiation' });
    let empty = 0;
    let nonEmpty = 0;
    for (let episode = 0; episode < 300; episode += 1) {
      const truth = readGroundTruth(
        scenario.generate(episode, 'train', ROLES).groundTruth,
      );
      for (const code of truth.senderOrder) {
        const utilityA = truth.utilities?.['baby-a'][String(code)] as number;
        const utilityB = truth.utilities?.['baby-b'][String(code)] as number;
        expect(Math.abs(utilityA + utilityB - 11)).toBeLessThanOrEqual(1);
      }
      if (zoneOfPossibleAgreement(truth).length === 0) {
        empty += 1;
      } else {
        nonEmpty += 1;
      }
    }
    expect(empty).toBeGreaterThan(0);
    expect(nonEmpty).toBeGreaterThan(0);
  });

  it('gives each Baby only its own utility and reservation columns', () => {
    const scenario = engine({ interactionMode: 'semi-cooperative-negotiation' });
    const instance = scenario.generate(4, 'train', ROLES);
    const truth = readGroundTruth(instance.groundTruth);
    const senderRows = instance.observations['baby-a'] as number[][];
    const receiverRows = instance.observations['baby-b'] as number[][];

    senderRows.forEach((row, index) => {
      const code = truth.senderOrder[index] as number;
      expect(row).toEqual([
        ...(truth.attributeCodes[String(code)] as number[]),
        code === truth.targetTypeCode ? 1 : 0,
        truth.utilities?.['baby-a'][String(code)] as number,
        truth.reservations?.['baby-a'] as number,
      ]);
    });
    receiverRows.forEach((row, index) => {
      const code = truth.receiverOrder[index] as number;
      expect(row).toEqual([
        ...(truth.attributeCodes[String(code)] as number[]),
        truth.utilities?.['baby-b'][String(code)] as number,
        truth.reservations?.['baby-b'] as number,
      ]);
    });
  });

  it('reports agreement, utilities, and joint utility for a negotiation selection', () => {
    const scenario = engine({ interactionMode: 'semi-cooperative-negotiation' });
    const instance = scenario.generate(6, 'train', ROLES);
    const truth = readGroundTruth(instance.groundTruth);
    const inZone = (truth.zopaRefs as string[])[0] as string;

    const accepted = scenario.evaluate(instance, selectAction(inZone));
    expect(accepted.agreement).toBe(true);
    expect(accepted.success).toBe(true);
    expect(accepted.reward).toBe(1);
    const utilities = accepted.utilities as Record<BabyRole, number>;
    expect(accepted.details.jointUtility).toBe(
      utilities['baby-a'] + utilities['baby-b'],
    );

    const outside = instance.candidateRefs.find(
      (ref) => !(truth.zopaRefs as string[]).includes(ref),
    );
    if (outside !== undefined) {
      const rejected = scenario.evaluate(instance, selectAction(outside));
      expect(rejected.agreement).toBe(false);
      expect(rejected.success).toBe(false);
      expect(rejected.reward).toBe(0);
      expect(rejected.details.reason).toBe('no-agreement');
    }
  });

  it('returns every candidate as acceptable when no reservations exist', () => {
    const instance = engine().generate(1, 'train', ROLES);
    expect(zoneOfPossibleAgreement(instance.groundTruth)).toEqual(
      instance.candidateRefs,
    );
  });
});

describe('observationFor (ALD-037 + ALD-038)', () => {
  const scenario = engine();

  it('builds exactly the SPEC §11.2 fields for each role', () => {
    const instance = scenario.generate(12, 'train', ROLES);
    for (const role of ['baby-a', 'baby-b'] as BabyRole[]) {
      const observation = scenario.observationFor(instance, 'run-e03-0007', 3, role);
      expect(Object.keys(observation).sort()).toEqual([
        'encoding',
        'payload',
        'recipient',
        'runId',
        'scenarioRef',
        'turn',
      ]);
      expect(observation).toMatchObject({
        runId: 'run-e03-0007',
        turn: 3,
        recipient: role,
        encoding: 'opaque-numeric',
        scenarioRef: instance.scenarioRef,
      });
      expect(observation.payload).toEqual(instance.observations[role]);
    }
  });

  it('is byte-identical for identical state and independent of the instance object', () => {
    const instance = scenario.generate(12, 'train', ROLES);
    const again = scenario.generate(12, 'train', ROLES);
    expect(canonicalJson(scenario.observationFor(again, 'run-1', 0, 'baby-a'))).toBe(
      canonicalJson(scenario.observationFor(instance, 'run-1', 0, 'baby-a')),
    );

    const observation = scenario.observationFor(instance, 'run-1', 0, 'baby-a');
    (instance.observations['baby-a'] as number[][])[0] = [9, 9, 9];
    expect(observation.payload).not.toEqual(instance.observations['baby-a']);
  });

  it('throws HygieneViolationError rather than delivering a tainted payload', () => {
    const instance = scenario.generate(13, 'train', ROLES);
    const tainted: ScenarioInstance = {
      ...instance,
      observations: {
        'baby-a': [[0, 1, 'red' as unknown as number]],
        'baby-b': instance.observations['baby-b'],
      },
    };
    expect(() => scenario.observationFor(tainted, 'run-1', 0, 'baby-a')).toThrow(
      HygieneViolationError,
    );
    try {
      scenario.observationFor(tainted, 'run-1', 0, 'baby-a');
    } catch (error) {
      expect(error).toBeInstanceOf(HygieneViolationError);
      expect((error as HygieneViolationError).reasonCodes).toContain('string-value');
    }
  });

  it('routes hygiene violations to an audit sink', () => {
    const seen: string[][] = [];
    const audited = new ReferentialScenarioEngine(
      { version: 1, symbolInventory: INVENTORY_32 },
      RUN_SEED,
      { onViolation: (errors) => seen.push(errors.map((entry) => entry.reason)) },
    );
    const instance = audited.generate(14, 'train', ROLES);
    expect(() =>
      audited.observationFor(instance, 'a descriptive red circle run', 0, 'baby-a'),
    ).toThrow(HygieneViolationError);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('human-language-token');
  });
});
