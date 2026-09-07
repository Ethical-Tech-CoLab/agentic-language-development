import { describe, expect, it } from 'vitest';

import { ObservationSchema } from '@ald/types';

import {
  BANNED_LANGUAGE_TOKENS,
  HygieneViolationError,
  OBSERVATION_FIELDS,
  assertObservationHygiene,
  hygieneErrors,
  scanForHumanLanguage,
} from '../src/index.js';

const CLEAN = {
  runId: 'run-e03-0007',
  turn: 4,
  recipient: 'baby-a',
  encoding: 'opaque-numeric',
  payload: [
    [0, 3, 1],
    [2, 1, 0],
  ],
  scenarioRef: 'scn:0123456789abcdef',
};

function reasons(observation: unknown, extraTokens?: string[]): string[] {
  return hygieneErrors(
    observation,
    extraTokens ? { extraTokens } : {},
  ).map((error) => error.reason);
}

describe('assertObservationHygiene', () => {
  it('passes a clean observation through and returns it typed', () => {
    expect(hygieneErrors(CLEAN)).toEqual([]);
    const observation = assertObservationHygiene(CLEAN);
    expect(ObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.payload).toEqual(CLEAN.payload);
    expect(Object.keys(observation).sort()).toEqual([...OBSERVATION_FIELDS].sort());
  });

  it('accepts a flat numeric vector payload', () => {
    expect(hygieneErrors({ ...CLEAN, payload: [0, 1, 2, 3] })).toEqual([]);
  });

  it('throws HygieneViolationError carrying reason codes, never the raw text', () => {
    let thrown: HygieneViolationError | undefined;
    try {
      assertObservationHygiene({
        ...CLEAN,
        caption: 'the red circle on the left is the target',
      });
    } catch (error) {
      thrown = error as HygieneViolationError;
    }
    expect(thrown).toBeInstanceOf(HygieneViolationError);
    expect(thrown?.reasonCodes).toContain('extra-top-level-key');
    expect(thrown?.reasonCodes).toContain('human-language-token');
    expect(thrown?.reasonCodes).toContain('prose-string');
    // SPEC §10.2: prohibited text must not travel in the message.
    expect(thrown?.message).not.toContain('red circle');
    expect(thrown?.errors.some((error) => error.text?.includes('red circle'))).toBe(
      true,
    );
  });

  it('notifies the audit sink before throwing (ALD-038 criterion 3)', () => {
    const audited: string[] = [];
    expect(() =>
      assertObservationHygiene(
        { ...CLEAN, payload: [[Number.NaN, 0, 0]] },
        { onViolation: (errors) => audited.push(...errors.map((e) => e.reason)) },
      ),
    ).toThrow(HygieneViolationError);
    expect(audited).toEqual(['non-finite-number']);
  });

  it('rejects a non-object observation', () => {
    expect(reasons('an observation')).toEqual(['unexpected-structure']);
    expect(reasons(null)).toEqual(['unexpected-structure']);
    expect(reasons([CLEAN])).toEqual(['unexpected-structure']);
  });
});

describe('§10.1 prohibited categories', () => {
  it('rejects a string anywhere in the payload', () => {
    expect(reasons({ ...CLEAN, payload: [['red', 1, 2]] })).toContain('string-value');
    expect(reasons({ ...CLEAN, payload: ['3', '4'] })).toContain('string-value');
  });

  it('rejects a human-language object key', () => {
    const withColorKey = { ...CLEAN, color: 2 };
    expect(reasons(withColorKey)).toContain('human-language-token');
    expect(reasons(withColorKey)).toContain('extra-top-level-key');
  });

  it('rejects camelCase and snake_case spellings of a banned token', () => {
    expect(reasons({ ...CLEAN, targetColor: 1 })).toContain('human-language-token');
    expect(reasons({ ...CLEAN, object_label: 1 })).toContain('human-language-token');
    expect(reasons({ ...CLEAN, 'is-correct': 1 })).toContain('human-language-token');
  });

  it('rejects a prose string', () => {
    expect(
      reasons({ ...CLEAN, note: 'pick the item that matches the sender hint' }),
    ).toContain('prose-string');
  });

  it('rejects a non-finite number', () => {
    expect(reasons({ ...CLEAN, payload: [[0, Number.NaN]] })).toContain(
      'non-finite-number',
    );
    expect(reasons({ ...CLEAN, payload: [[0, Number.POSITIVE_INFINITY]] })).toContain(
      'non-finite-number',
    );
    expect(reasons({ ...CLEAN, turn: Number.NaN })).toContain('non-finite-number');
  });

  it('rejects an emoji or other pictographic code point', () => {
    expect(reasons({ ...CLEAN, runId: 'run-🙂' })).toContain('pictographic');
    expect(reasons({ ...CLEAN, hint: '⭐' })).toContain('pictographic');
  });

  it('rejects an extra top-level key even when its name is opaque', () => {
    expect(reasons({ ...CLEAN, k7: 3 })).toEqual(['extra-top-level-key']);
  });

  it('rejects a missing required field', () => {
    const withoutTurn: Record<string, unknown> = { ...CLEAN };
    delete withoutTurn.turn;
    expect(reasons(withoutTurn)).toContain('unexpected-structure');
  });

  it('rejects payload rows of unequal length', () => {
    expect(reasons({ ...CLEAN, payload: [[0, 1], [0, 1, 2]] })).toContain(
      'ragged-payload',
    );
  });

  it('rejects a payload that mixes scalars and rows or nests deeper', () => {
    expect(reasons({ ...CLEAN, payload: [0, [1, 2]] })).toContain(
      'unexpected-structure',
    );
    expect(reasons({ ...CLEAN, payload: [[[1]], [[2]]] })).toContain(
      'unexpected-structure',
    );
    expect(reasons({ ...CLEAN, payload: 3 })).toContain('unexpected-structure');
  });

  it('rejects a descriptive or malformed scenarioRef', () => {
    expect(reasons({ ...CLEAN, scenarioRef: 'red-circle-episode' })).toContain(
      'scenario-ref-format',
    );
    expect(reasons({ ...CLEAN, scenarioRef: 'scn:00FF' })).toContain(
      'scenario-ref-format',
    );
    expect(reasons({ ...CLEAN, scenarioRef: 'scn:0123456789abcdefff' })).toContain(
      'scenario-ref-format',
    );
  });

  it('rejects a runId that is not an opaque identifier', () => {
    expect(reasons({ ...CLEAN, runId: 'run 7 of the naming game' })).toContain(
      'run-id-format',
    );
    expect(reasons({ ...CLEAN, runId: '' })).toContain('run-id-format');
    expect(reasons({ ...CLEAN, runId: `r${'0'.repeat(80)}` })).toContain(
      'run-id-format',
    );
    expect(reasons({ ...CLEAN, runId: '9f2c-4c9d-11ee-be56-0242ac120002' })).toEqual(
      [],
    );
  });

  describe('whitespace-free prose evades RUN_ID_PATTERN alone (regression)', () => {
    // RUN_ID_PATTERN forbids whitespace, so a whitespace-free English
    // sentence is pattern-valid; the prose heuristic — evaluated on the same
    // camel/snake/kebab/dot/colon/slash split the token scan uses — is what
    // must still catch it. See hygiene.ts `looksLikeProse`.
    it.each([
      'theRedCircleIsTheTarget',
      'the.red.circle',
      'select-left-object',
    ])('rejects %s', (runId) => {
      expect(reasons({ ...CLEAN, runId })).not.toEqual([]);
    });

    it('rejects a joined sentence that uses no banned vocabulary at all', () => {
      // Distinct from the cases above: none of these words are on
      // BANNED_LANGUAGE_TOKENS, so only the fixed prose heuristic — not the
      // token scan — can catch them. Before the fix, RUN_ID_PATTERN's ban on
      // whitespace meant `looksLikeProse` could never see more than one
      // "word" here and these were accepted outright.
      expect(reasons({ ...CLEAN, runId: 'moveToPositionThenWaitForSignal' })).toContain(
        'prose-string',
      );
      expect(
        reasons({ ...CLEAN, runId: 'do-not-trust-your-partner-this-round' }),
      ).toContain('prose-string');
      expect(
        reasons({ ...CLEAN, runId: 'hello.world.this.is.a.secret.message' }),
      ).toContain('prose-string');
    });

    it('still accepts a clean, conventional runId', () => {
      expect(reasons({ ...CLEAN, runId: 'run-e03-0007' })).toEqual([]);
    });

    it('does not flag the hyphenated run ids already used elsewhere in the monorepo', () => {
      // These decode to several all-alphabetic segments too, but contain no
      // closed-class function word, so the stopword-gated heuristic leaves
      // them valid. Regression guard: packages/orchestrator/__tests__ and
      // twins/packs/__tests__ drive real runs through this filter with ids
      // in exactly this shape.
      for (const runId of [
        'e03-disabled-s4',
        'repro-1',
        'run-append-only',
        'run-adapter-crash-evaluating',
        'run-adapter-crash-outcome',
        'run-disabled-scratch-rl',
      ]) {
        expect(reasons({ ...CLEAN, runId })).toEqual([]);
      }
    });
  });

  it('rejects a string outside the recipient and encoding allowlists', () => {
    expect(reasons({ ...CLEAN, recipient: 'baby-c' })).toContain('string-value');
    expect(reasons({ ...CLEAN, encoding: 'text' })).toContain('string-value');
  });

  it('honours experiment-specific extra tokens', () => {
    expect(reasons({ ...CLEAN, gizmo: 1 })).toEqual(['extra-top-level-key']);
    expect(reasons({ ...CLEAN, gizmo: 1 }, ['gizmo'])).toContain(
      'human-language-token',
    );
  });
});

describe('§10.1 category coverage (ALD-038 criterion 1)', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['semantic filename', { asset: 'scene_red_circle.png' }, 'human-language-token'],
    ['alt text', { alt: 'a small blue square' }, 'human-language-token'],
    ['caption', { caption: 'the correct object' }, 'human-language-token'],
    ['OCR-visible word', { payload: [['TARGET']] }, 'string-value'],
    ['semantic identifier', { scenarioRef: 'scn:red-circle-0001' }, 'scenario-ref-format'],
    ['task-state timestamp', { recordedAt: '2026-08-24T10:00:00Z' }, 'extra-top-level-key'],
    [
      'human-readable exception message',
      { error: 'selection failed because the target was already chosen' },
      'prose-string',
    ],
    ['other-agent private state', { partnerUtility: 7 }, 'extra-top-level-key'],
  ];

  for (const [name, patch, expected] of cases) {
    it(`blocks ${name}`, () => {
      expect(reasons({ ...CLEAN, ...patch })).toContain(expected);
    });
  }
});

describe('scanForHumanLanguage', () => {
  it('finds banned tokens in nested values and keys', () => {
    const offenders = scanForHumanLanguage({
      scene: { objects: [{ shape: 'triangle' }, { code: 4 }] },
      meta: ['left', 'o:0123456789ab'],
    });
    expect(offenders).toContain('shape');
    expect(offenders).toContain('triangle');
    expect(offenders).toContain('left');
    expect(offenders).not.toContain('o:0123456789ab');
  });

  it('returns nothing for hygienic numeric structures', () => {
    expect(scanForHumanLanguage(CLEAN)).toEqual([]);
    expect(scanForHumanLanguage([[0, 1], [2, 3]])).toEqual([]);
    expect(scanForHumanLanguage({ k1: 1, attributeCode: 7 })).toEqual([]);
  });

  it('matches whole words only', () => {
    expect(scanForHumanLanguage('bright starter')).toEqual([]);
    expect(scanForHumanLanguage('altitude')).toEqual([]);
    expect(scanForHumanLanguage({ RED: 1 })).toContain('RED');
  });

  it('flags prose and pictographic strings without a banned token', () => {
    expect(scanForHumanLanguage('pick whichever item you prefer here')).toHaveLength(
      1,
    );
    expect(scanForHumanLanguage(['🎯'])).toEqual(['🎯']);
  });

  it('flags a whitespace-free joined sentence the same as its spaced form', () => {
    expect(scanForHumanLanguage('pickTheItemThatMatchesTheSenderHint')).toEqual([
      'pickTheItemThatMatchesTheSenderHint',
    ]);
    expect(scanForHumanLanguage('run-append-only')).toEqual([]);
  });

  it('accepts extra tokens and survives a cyclic structure', () => {
    expect(scanForHumanLanguage({ widget: 'gizmo' }, ['gizmo'])).toEqual(['gizmo']);
    const cyclic: Record<string, unknown> = { code: 1 };
    cyclic.self = cyclic;
    expect(scanForHumanLanguage(cyclic)).toEqual([]);
  });

  it('keeps the maintained token list covering every §10.1 example', () => {
    for (const token of ['red', 'circle', 'target', 'correct', 'label', 'caption']) {
      expect(BANNED_LANGUAGE_TOKENS).toContain(token);
    }
  });
});
