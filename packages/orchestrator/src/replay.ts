/**
 * Replay fidelity checks (SPECIFICATION.md §14.3).
 *
 * Two independent checks are defined there and both are pure functions over
 * the `turns` stream, so a researcher (or the independent verifier) can run
 * them from an exported bundle without the runtime:
 *
 * 1. **scenario replay** — regenerate every scenario and private observation
 *    from the recorded configuration and seed and reproduce the recorded
 *    scenario/observation hashes;
 * 2. **execution replay** — a `replayDigest` over the ordered tuples
 *    `(turn, scenarioStateHash, babyAObservationHash, babyBObservationHash,
 *    babyProposalHash, deliveredArtifactHash, actionHash, outcomeHash)`,
 *    domain `dtsf-replay-digest-v1`, which excludes wall-clock timestamps,
 *    writer signatures, anchor receipts, and event-chain hashes.
 */
import {
  HASH_DOMAINS,
  type ScenarioEngine,
  type ScenarioSplit,
  type Sha256Hash,
  type TurnRecord,
} from '@ald/types';
import { hashCanonical } from '@ald/hashing';
import { hashObservation } from '@ald/scenario';

/**
 * One §14.3 tuple. It is encoded as a JSON array rather than an object so the
 * digest depends on the documented field *order*, which is what the
 * specification names; canonical JSON would otherwise sort object keys and
 * silently accept a different reading of the tuple.
 */
export type ReplayTuple = [
  turn: number,
  scenarioStateHash: Sha256Hash,
  babyAObservationHash: Sha256Hash,
  babyBObservationHash: Sha256Hash,
  babyProposalHash: Sha256Hash | null,
  deliveredArtifactHash: Sha256Hash,
  actionHash: Sha256Hash,
  outcomeHash: Sha256Hash,
];

/** The §14.3 tuples of one run, in turn-record order. */
export function replayTuples(
  records: readonly TurnRecord[],
): ReplayTuple[] {
  return records.map((record) => [
    record.turn,
    record.scenarioStateHash,
    record.observationHashes.babyA,
    record.observationHashes.babyB,
    record.babyProposalHash,
    record.deliveredArtifactHash,
    record.actionHash,
    record.outcomeHash,
  ]);
}

/** SPEC §14.3 `replayDigest` of one run's ordered turn records. */
export function replayDigest(records: readonly TurnRecord[]): Sha256Hash {
  return hashCanonical(HASH_DOMAINS.replayDigest, replayTuples(records));
}

export interface ScenarioReplayResult {
  ok: boolean;
  /** Human-readable mismatch per failing turn; empty when `ok`. */
  mismatches: string[];
  turnsChecked: number;
}

export interface ScenarioReplayInput {
  runId: string;
  records: readonly TurnRecord[];
  /** A freshly seeded engine built from the *recorded* configuration. */
  engine: ScenarioEngine;
}

/**
 * The episode index of a turn is not stored in the turn record: it is the
 * count of turns already executed in that split, which the recorded `phase`
 * column reconstructs exactly (`running` draws from `train`, `evaluating`
 * from the held-out `evaluation` split — SPEC §7.1, §8.1).
 */
function splitFor(phase: TurnRecord['phase']): ScenarioSplit {
  return phase === 'evaluating' ? 'evaluation' : 'train';
}

/** SPEC §14.3 check 1: scenario replay from the seed alone. */
export function scenarioReplayCheck(
  input: ScenarioReplayInput,
): ScenarioReplayResult {
  const mismatches: string[] = [];
  const episodes: Record<ScenarioSplit, number> = {
    train: 0,
    validation: 0,
    'held-out': 0,
    evaluation: 0,
  };

  for (const record of input.records) {
    const split = splitFor(record.phase);
    const episodeIndex = episodes[split];
    episodes[split] += 1;

    let regenerated;
    try {
      regenerated = input.engine.generate(episodeIndex, split, record.roles);
    } catch (error) {
      mismatches.push(
        `turn ${record.turn}: regeneration failed (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      continue;
    }

    if (regenerated.scenarioRef !== record.scenarioRef) {
      mismatches.push(
        `turn ${record.turn}: scenarioRef ${regenerated.scenarioRef} != recorded ${record.scenarioRef}`,
      );
    }
    if (regenerated.stateHash !== record.scenarioStateHash) {
      mismatches.push(
        `turn ${record.turn}: scenarioStateHash ${regenerated.stateHash} != recorded ${record.scenarioStateHash}`,
      );
    }

    const observed = {
      babyA: hashObservation(
        input.engine.observationFor(
          regenerated,
          input.runId,
          record.turn,
          'baby-a',
        ),
      ),
      babyB: hashObservation(
        input.engine.observationFor(
          regenerated,
          input.runId,
          record.turn,
          'baby-b',
        ),
      ),
    };
    for (const baby of ['babyA', 'babyB'] as const) {
      if (observed[baby] !== record.observationHashes[baby]) {
        mismatches.push(
          `turn ${record.turn}: ${baby} observation hash ${observed[baby]} != recorded ${record.observationHashes[baby]}`,
        );
      }
    }
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    turnsChecked: input.records.length,
  };
}
