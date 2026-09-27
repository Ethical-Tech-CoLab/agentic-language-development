/**
 * LV01 shared action draw (R04 item 3).
 *
 * All branches of one case share a single receiver-selection draw derived
 * from the v2 seed policy without any branch part. The runtime commits the
 * draw pre-action (seed and unit value stay hidden), the receiver adapter
 * selects by inverse CDF over the shared unit value, and the post-action
 * disclosure lets the auditor reproduce the chosen candidate from the
 * recorded probability vector.
 */
import { deriveSeedHex, drawIndexFromUnit, hashCanonical, SeededPrng, unitBitsHex } from '@ald/hashing';

export const LV01_ACTION_DRAW_U_DOMAIN = 'lv01-receiver-draw-u/v1' as const;
export const LV01_ACTION_DRAW_COMMITMENT_DOMAIN = 'lv01-receiver-draw/v2' as const;

function fail(message: string): never {
  throw new Error(`LV01 action draw: ${message}`);
}

export interface Lv01ActionDrawScope {
  readonly stage: 'development' | 'qualification' | 'shadow' | 'generalization' | 'pilot';
  readonly slotKind: 'primary' | 'reserve';
  /** Zero-padded slot number, e.g. `0007`. */
  readonly slotIndex: string;
  readonly partition: 'dev' | 'within-support' | 'novel-composition';
  readonly receiverRole: 'baby-a' | 'baby-b';
  readonly caseId: string;
}

const STAGES = ['development', 'qualification', 'shadow', 'generalization', 'pilot'] as const;

export function assertLv01ActionDrawScope(scope: Lv01ActionDrawScope): void {
  if (!STAGES.includes(scope.stage)) fail('draw scope stage is invalid');
  if (scope.slotKind !== 'primary' && scope.slotKind !== 'reserve') {
    fail('draw scope slot kind is invalid');
  }
  if (!/^\d{4}$/u.test(scope.slotIndex)) fail('draw scope slot index must be zero-padded');
  if (!['dev', 'within-support', 'novel-composition'].includes(scope.partition)) {
    fail('draw scope partition is invalid');
  }
  if (scope.receiverRole !== 'baby-a' && scope.receiverRole !== 'baby-b') {
    fail('draw scope receiver role is invalid');
  }
  if (scope.caseId.length === 0) fail('draw scope case identity is empty');
}

/**
 * Shared draw seed. No branch part: every branch of the case derives the
 * same seed. The root is the parent run's random seed for paired cases.
 */
export function deriveLv01ActionDrawSeed(
  seedRoot: string,
  scope: Lv01ActionDrawScope,
): string {
  if (seedRoot.length === 0) fail('draw seed root is empty');
  assertLv01ActionDrawScope(scope);
  return deriveSeedHex(
    seedRoot,
    'LV01',
    scope.stage,
    'v2',
    scope.slotKind,
    scope.slotIndex,
    'action-draw',
    scope.receiverRole,
    scope.partition,
    scope.caseId,
  );
}

/** The shared unit draw for one case turn. Reproducible by the auditor from the seed. */
export function drawLv01SharedUnit(drawSeed: string, turn: number): number {
  if (drawSeed.length === 0) fail('draw seed is empty');
  if (!Number.isInteger(turn) || turn < 0) fail('draw turn is invalid');
  return new SeededPrng(drawSeed)
    .derive(LV01_ACTION_DRAW_U_DOMAIN)
    .derive(String(turn))
    .nextFloat();
}

export interface Lv01ActionDrawCommitmentInput {
  readonly drawSeed: string;
  readonly turn: number;
  readonly receiver: 'baby-a' | 'baby-b';
  readonly candidateRefs: readonly string[];
  readonly preStateCommitment: string;
}

export interface Lv01ActionDrawCommitment {
  readonly drawSeedCommitment: string;
  readonly uCommitment: string;
  readonly uBitsHex: string;
  readonly drawCommitment: string;
}

/**
 * Draw the shared unit value and bind hiding commitments. The seed and the
 * unit value enter no pre-action evidence; only the digests do.
 */
export function commitLv01ActionDraw(
  input: Lv01ActionDrawCommitmentInput,
): { u: number } & Lv01ActionDrawCommitment {
  if (input.receiver !== 'baby-a' && input.receiver !== 'baby-b') fail('draw receiver is invalid');
  if (input.candidateRefs.length === 0) fail('draw requires candidate references');
  const u = drawLv01SharedUnit(input.drawSeed, input.turn);
  const bits = unitBitsHex(u);
  const drawSeedCommitment = hashCanonical('lv01-action-draw-seed/v1', input.drawSeed);
  const uCommitment = hashCanonical('lv01-action-draw-u-commit/v1', bits);
  return {
    u,
    uBitsHex: bits,
    drawSeedCommitment,
    uCommitment,
    drawCommitment: hashCanonical(LV01_ACTION_DRAW_COMMITMENT_DOMAIN, {
      drawSeedCommitment,
      uCommitment,
      candidateRefsHash: hashCanonical('lv01-draw-candidates/v1', [...input.candidateRefs]),
      turn: input.turn,
      receiver: input.receiver,
      preStateCommitment: input.preStateCommitment,
    }),
  };
}

export interface Lv01ActionDrawDisclosure {
  readonly uBitsHex: string;
  readonly probs: readonly number[];
  readonly candidateRefs: readonly string[];
  readonly selectedCandidateRef: string;
}

/**
 * Reproduce the disclosed selection from the seed, the unit value, and the
 * recorded sampling vector. Rejects a wrong unit value, a swapped vector,
 * or a mismatched candidate order.
 */
export function verifyLv01ActionDraw(input: {
  readonly drawSeed: string;
  readonly turn: number;
  readonly disclosure: Lv01ActionDrawDisclosure;
}): void {
  const u = drawLv01SharedUnit(input.drawSeed, input.turn);
  if (unitBitsHex(u) !== input.disclosure.uBitsHex) {
    fail('disclosed unit value does not match the draw seed');
  }
  const index = drawIndexFromUnit(input.disclosure.probs, u);
  if (input.disclosure.candidateRefs[index] !== input.disclosure.selectedCandidateRef) {
    fail('disclosed selection does not follow the shared draw');
  }
}
