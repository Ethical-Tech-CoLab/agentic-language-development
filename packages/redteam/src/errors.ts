/**
 * Closed error-code union for `@ald/redteam`.
 *
 * The package is a measurement and harness library: every failure is an
 * input-domain failure or a fixture-integrity failure, never a research
 * result. Callers get a stable `code` so a harness records the failure
 * without matching on message text.
 */
export type RedTeamErrorCode =
  /** A sample or fixture list that must be non-empty is empty. */
  | 'empty-sample'
  | 'empty-suite'
  /** Two samples that must align do not. */
  | 'length-mismatch'
  /** A numeric argument outside its domain (a negative duration, NaN, …). */
  | 'domain'
  /** Fewer distinct labels than the comparison needs. */
  | 'insufficient-labels'
  /** A committed fixture disagrees with the manifest. */
  | 'fixture-integrity';

export class RedTeamError extends Error {
  constructor(
    readonly code: RedTeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export function assertFiniteSample(values: readonly number[], label: string): void {
  if (values.length === 0) {
    throw new RedTeamError('empty-sample', `${label} must not be empty`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Number.isFinite(values[index] ?? Number.NaN)) {
      throw new RedTeamError('domain', `${label}[${index}] must be a finite number`);
    }
  }
}
