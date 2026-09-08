/**
 * Error type for the intervention planner and its readiness scaffolds
 * (BACKLOG ALD-072).
 *
 * Every module in this package is pure: a failure is always an input-domain
 * failure — a plan that violates SPEC §15.2/§18, an observation set that does
 * not match the schedule it claims to belong to, or a curriculum stage an
 * adapter cannot honour. Callers get a stable `code` so a harness can record
 * the failure in evidence without matching on message text.
 *
 * These errors are researcher-facing. Nothing in this package runs inside a
 * Baby's isolation boundary, so no message here can reach a Baby context
 * (SPEC §10.3).
 */
export type InterventionErrorCode =
  /** The `InterventionPlan` is not usable for the requested operation. */
  | 'invalid-plan'
  /** Evaluation turns, ledgers, inventory, or seed are missing or malformed. */
  | 'invalid-input'
  /** Observed probe outcomes do not line up with the schedule. */
  | 'schedule-mismatch'
  /** A curriculum stage list violates SPEC §18 / E22 ordering rules. */
  | 'invalid-curriculum'
  /** A stage sets a knob the target adapter declared it cannot apply. */
  | 'unsupported-curriculum-knob'
  /** Not enough probes, seeds, or episodes for the requested statistic. */
  | 'insufficient-data';

export class InterventionError extends Error {
  constructor(
    public readonly code: InterventionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InterventionError';
  }
}

export function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InterventionError(
      'invalid-input',
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

export function assertTurnList(
  turns: readonly number[],
  label: string,
): readonly number[] {
  if (turns.length === 0) {
    throw new InterventionError('invalid-input', `${label} must not be empty`);
  }
  let previous = -1;
  turns.forEach((turn, index) => {
    if (!Number.isInteger(turn) || turn < 0) {
      throw new InterventionError(
        'invalid-input',
        `${label}[${index}] must be a non-negative integer`,
      );
    }
    if (turn <= previous) {
      throw new InterventionError(
        'invalid-input',
        `${label} must be strictly increasing`,
      );
    }
    previous = turn;
  });
  return turns;
}
