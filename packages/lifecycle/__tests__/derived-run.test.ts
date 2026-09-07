import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { RunConfig } from '@ald/types';
import {
  LineageError,
  RunConfigValidationError,
  assertLineage,
  buildRunConfig,
  createDerivedRunConfig,
  hashRunConfig,
  isDerivedRunConfig,
  readLineage,
  validateRunConfig,
} from '@ald/lifecycle';

const PARENT_CHECKPOINT = `sha256:${'ab'.repeat(32)}`;

function parentConfig(): RunConfig {
  return buildRunConfig({
    runId: 'run-parent',
    experimentId: 'E30',
    randomSeed: 'seed-parent',
    evaluationSeeds: 10,
    maxTurnsPerRun: 64,
  });
}

const OPTIONS = {
  babyAInitialPolicyRef: 'policy-a@turn-64',
  babyBInitialPolicyRef: 'policy-b@turn-64',
};

describe('createDerivedRunConfig (SPEC §7.4, ALD-028)', () => {
  it('records every lineage field and round-trips through validateRunConfig', () => {
    const parent = parentConfig();
    const child = createDerivedRunConfig(
      parent,
      PARENT_CHECKPOINT,
      'run-child',
      OPTIONS,
    );

    expect(child.runId).toBe('run-child');
    expect(child.parentRunId).toBe('run-parent');
    expect(child.derivedFromCheckpointHash).toBe(PARENT_CHECKPOINT);
    expect(child.babyA.initialPolicyRef).toBe('policy-a@turn-64');
    expect(child.babyB.initialPolicyRef).toBe('policy-b@turn-64');

    const result = validateRunConfig(child);
    expect(result.ok).toBe(true);
    expect(result.ok && result.configurationHash).toBe(hashRunConfig(child));
    expect(isDerivedRunConfig(child)).toBe(true);
    expect(isDerivedRunConfig(parent)).toBe(false);
    expect(assertLineage(child, parent)).toEqual({
      runId: 'run-child',
      parentRunId: 'run-parent',
      derivedFromCheckpointHash: PARENT_CHECKPOINT,
      babyAInitialPolicyRef: 'policy-a@turn-64',
      babyBInitialPolicyRef: 'policy-b@turn-64',
    });
  });

  it('inherits every other parent field and hashes differently', () => {
    const parent = parentConfig();
    const child = createDerivedRunConfig(
      parent,
      PARENT_CHECKPOINT,
      'run-child',
      OPTIONS,
    );

    expect(child.experimentId).toBe(parent.experimentId);
    expect(child.carrierMode).toBe(parent.carrierMode);
    expect(child.symbolInventorySize).toBe(parent.symbolInventorySize);
    expect(child.maxTurnsPerRun).toBe(parent.maxTurnsPerRun);
    expect(child.preRegistrationHash).toBe(parent.preRegistrationHash);
    expect(hashRunConfig(child)).not.toBe(hashRunConfig(parent));
  });

  it('never mutates the parent configuration', () => {
    const parent = parentConfig();
    const snapshot = structuredClone(parent);
    const parentHash = hashRunConfig(parent);
    createDerivedRunConfig(parent, PARENT_CHECKPOINT, 'run-child', OPTIONS);
    expect(parent).toEqual(snapshot);
    expect(hashRunConfig(parent)).toBe(parentHash);
  });

  it('applies pre-registered overrides, including a replacement learner (E30)', () => {
    const parent = parentConfig();
    const child = createDerivedRunConfig(
      parent,
      PARENT_CHECKPOINT,
      'run-child',
      {
        ...OPTIONS,
        overrides: {
          randomSeed: 'seed-child',
          symmetricTracks: false,
          babyB: {
            track: 'hybrid',
            modelRef: 'hybrid-partner-v1',
            trainingIsolation: 'independent',
          },
        },
      },
    );

    expect(child.randomSeed).toBe('seed-child');
    expect(child.babyA.track).toBe('scratch-rl');
    expect(child.babyB.track).toBe('hybrid');
    expect(child.babyB.modelRef).toBe('hybrid-partner-v1');
    expect(child.symmetricTracks).toBe(false);
    // The lineage bindings always win over the overrides.
    expect(child.babyB.initialPolicyRef).toBe('policy-b@turn-64');
    expect(validateRunConfig(child).ok).toBe(true);
  });

  it('lets overrides not defeat the lineage bindings', () => {
    const parent = parentConfig();
    const child = createDerivedRunConfig(
      parent,
      PARENT_CHECKPOINT,
      'run-child',
      {
        ...OPTIONS,
        overrides: {
          runId: 'run-impostor',
          parentRunId: 'run-somebody-else',
          derivedFromCheckpointHash: `sha256:${'cd'.repeat(32)}`,
        },
      },
    );
    expect(child.runId).toBe('run-child');
    expect(child.parentRunId).toBe('run-parent');
    expect(child.derivedFromCheckpointHash).toBe(PARENT_CHECKPOINT);
  });

  it('rejects reusing the parent run identifier', () => {
    const parent = parentConfig();
    expect(() =>
      createDerivedRunConfig(parent, PARENT_CHECKPOINT, parent.runId, OPTIONS),
    ).toThrow(LineageError);
    expect(() =>
      createDerivedRunConfig(parent, PARENT_CHECKPOINT, '', OPTIONS),
    ).toThrow(LineageError);
  });

  it('rejects a malformed parent checkpoint hash', () => {
    const parent = parentConfig();
    expect(() =>
      createDerivedRunConfig(parent, 'not-a-hash', 'run-child', OPTIONS),
    ).toThrow(RunConfigValidationError);
  });

  it('rejects overrides that break an ALD-023 rule', () => {
    const parent = parentConfig();
    expect(() =>
      createDerivedRunConfig(parent, PARENT_CHECKPOINT, 'run-child', {
        ...OPTIONS,
        overrides: { learningSignal: 'none' },
      }),
    ).toThrow(RunConfigValidationError);
  });

  it('supports a chain of derived runs (E50 replication)', () => {
    let current = parentConfig();
    for (let generation = 1; generation <= 5; generation += 1) {
      const child = createDerivedRunConfig(
        current,
        `sha256:${String(generation).repeat(64)}`,
        `run-generation-${generation}`,
        {
          babyAInitialPolicyRef: `policy-a@gen-${generation}`,
          babyBInitialPolicyRef: `policy-b@gen-${generation}`,
          overrides: { randomSeed: `seed-gen-${generation}` },
        },
      );
      expect(assertLineage(child, current).parentRunId).toBe(current.runId);
      expect(child.runId).not.toBe(current.runId);
      current = child;
    }
    expect(current.runId).toBe('run-generation-5');
  });
});

describe('assertLineage and readLineage (SPEC §7.4)', () => {
  const parent = parentConfig();
  const child = createDerivedRunConfig(
    parent,
    PARENT_CHECKPOINT,
    'run-child',
    OPTIONS,
  );

  it('rejects a root configuration', () => {
    expect(() => readLineage(parent)).toThrow(LineageError);
    expect(() => assertLineage(parent, parent)).toThrow(LineageError);
    try {
      readLineage(parent);
    } catch (error) {
      expect((error as LineageError).field).toBe('parentRunId');
    }
  });

  it('rejects each individually missing lineage field', () => {
    const cases: Array<[string, RunConfig]> = [
      [
        'parentRunId',
        { ...child, parentRunId: undefined } as unknown as RunConfig,
      ],
      [
        'derivedFromCheckpointHash',
        { ...child, derivedFromCheckpointHash: undefined } as unknown as RunConfig,
      ],
      [
        'babyA.initialPolicyRef',
        { ...child, babyA: { ...parent.babyA } },
      ],
      [
        'babyB.initialPolicyRef',
        { ...child, babyB: { ...parent.babyB } },
      ],
    ];

    for (const [field, broken] of cases) {
      try {
        assertLineage(broken, parent);
        expect.unreachable(`expected ${field} to be reported`);
      } catch (error) {
        expect(error).toBeInstanceOf(LineageError);
        expect((error as LineageError).field).toBe(field);
      }
    }
  });

  it('rejects a child that points at a different parent', () => {
    const otherParent = buildRunConfig({
      runId: 'run-other-parent',
      experimentId: 'E30',
      randomSeed: 'seed-other',
      evaluationSeeds: 10,
    });
    try {
      assertLineage(child, otherParent);
      expect.unreachable('expected a lineage failure');
    } catch (error) {
      expect(error).toBeInstanceOf(LineageError);
      expect((error as LineageError).field).toBe('parentRunId');
      expect((error as LineageError).message).toContain('run-other-parent');
    }
  });

  it('rejects a child that reuses the parent run identifier', () => {
    const impostor = { ...child, runId: parent.runId };
    try {
      assertLineage(impostor, parent);
      expect.unreachable('expected a lineage failure');
    } catch (error) {
      expect((error as LineageError).field).toBe('runId');
    }
  });

  it('revalidates the child configuration', () => {
    const broken = { ...child, symmetricTracks: false };
    expect(() => assertLineage(broken, parent)).toThrow(
      RunConfigValidationError,
    );
  });
});

describe('reserved vocabulary (SPEC §7.4)', () => {
  const parent = parentConfig();

  function messageOf(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected the action to throw');
  }

  it('never uses the §7.3 integrity term in a user-facing message', () => {
    const messages = [
      messageOf(() =>
        createDerivedRunConfig(parent, PARENT_CHECKPOINT, parent.runId, OPTIONS),
      ),
      messageOf(() =>
        createDerivedRunConfig(parent, PARENT_CHECKPOINT, '', OPTIONS),
      ),
      messageOf(() => readLineage(parent)),
      messageOf(() => assertLineage({ ...parent }, parent)),
      messageOf(() =>
        assertLineage(
          createDerivedRunConfig(parent, PARENT_CHECKPOINT, 'run-child', OPTIONS),
          buildRunConfig({
            runId: 'run-elsewhere',
            experimentId: 'E30',
            randomSeed: 'seed-elsewhere',
            evaluationSeeds: 10,
          }),
        ),
      ),
    ];

    expect(messages).toHaveLength(5);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/fork/iu);
      expect(message).toMatch(/derived run|runId|lineage|configuration/u);
    }
  });

  it('never uses the term anywhere in the derived-run module', () => {
    const source = readFileSync(
      new URL('../src/derived-run.ts', import.meta.url),
      'utf8',
    );
    expect(source.length).toBeGreaterThan(0);
    expect(source).not.toMatch(/fork/iu);
    expect(source).toMatch(/derived run/u);
  });
});
