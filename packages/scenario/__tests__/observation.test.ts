import { describe, expect, it } from 'vitest';

import { HASH_DOMAINS, ObservationSchema } from '@ald/types';
import { canonicalJson, hashCanonical } from '@ald/hashing';

import {
  HygieneViolationError,
  buildObservation,
  hashObservation,
  type ObservationBuildInput,
} from '../src/index.js';

const INPUT = {
  runId: 'run-e03-0007',
  turn: 2,
  recipient: 'baby-b' as const,
  encoding: 'opaque-numeric' as const,
  payload: [
    [1, 2],
    [3, 0],
  ],
  scenarioRef: 'scn:00112233445566aa',
};

describe('buildObservation (ALD-037)', () => {
  it('assembles exactly the SPEC §11.2 fields', () => {
    const observation = buildObservation(INPUT);
    expect(Object.keys(observation).sort()).toEqual([
      'encoding',
      'payload',
      'recipient',
      'runId',
      'scenarioRef',
      'turn',
    ]);
    expect(ObservationSchema.safeParse(observation).success).toBe(true);
  });

  it('drops any field that is not in §11.2', () => {
    // A caller passing extra scenario state must not leak it through.
    const noisy = { ...INPUT, targetTypeCode: 7 } as unknown as ObservationBuildInput;
    const observation = buildObservation(noisy);
    expect('targetTypeCode' in observation).toBe(false);
  });

  it('is byte-identical for identical state (ALD-037 criterion 2)', () => {
    expect(canonicalJson(buildObservation(INPUT))).toBe(
      canonicalJson(buildObservation({ ...INPUT, payload: [[1, 2], [3, 0]] })),
    );
    expect(canonicalJson(buildObservation({ ...INPUT, turn: 3 }))).not.toBe(
      canonicalJson(buildObservation(INPUT)),
    );
  });

  it('copies the payload so later mutation cannot reach a learner', () => {
    const payload = [
      [1, 2],
      [3, 0],
    ];
    const observation = buildObservation({ ...INPUT, payload });
    payload[0] = [9, 9];
    expect(observation.payload).toEqual([
      [1, 2],
      [3, 0],
    ]);
  });

  it('refuses to build an observation that fails §10.1 hygiene', () => {
    expect(() =>
      buildObservation({ ...INPUT, scenarioRef: 'episode-red-circle-1' }),
    ).toThrow(HygieneViolationError);
    expect(() =>
      buildObservation({ ...INPUT, payload: [[1, Number.NaN]] }),
    ).toThrow(HygieneViolationError);
  });

  it('hashes an observation under the observation domain', () => {
    const observation = buildObservation(INPUT);
    expect(hashObservation(observation)).toBe(
      hashCanonical(HASH_DOMAINS.observation, observation),
    );
    expect(hashObservation(observation)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
