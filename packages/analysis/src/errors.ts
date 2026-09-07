/**
 * Error type for the pre-registered statistics toolkit (BACKLOG ALD-072).
 *
 * The toolkit is pure and deterministic: every failure is an input-domain or
 * numerical-convergence failure, never I/O. Callers get a stable `code` so a
 * harness can record the failure in evidence without string matching.
 */
export type AnalysisErrorCode =
  | 'domain'
  | 'empty-sample'
  | 'length-mismatch'
  | 'no-convergence';

export class AnalysisError extends Error {
  constructor(
    public readonly code: AnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
  }
}

/** Every value must be a finite number; the toolkit never silently drops NaN. */
export function assertFiniteValues(
  values: readonly number[],
  label: string,
): void {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] as number;
    if (!Number.isFinite(value)) {
      throw new AnalysisError(
        'domain',
        `${label}[${index}] must be a finite number`,
      );
    }
  }
}

/** Non-empty finite sample; `summarize` and the tests below all require it. */
export function assertSample(values: readonly number[], label: string): void {
  if (values.length === 0) {
    throw new AnalysisError('empty-sample', `${label} must not be empty`);
  }
  assertFiniteValues(values, label);
}

/** A probability in the closed unit interval. */
export function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AnalysisError('domain', `${label} must be within [0, 1]`);
  }
}

/** A confidence level strictly inside (0, 1), e.g. 0.95. */
export function assertLevel(level: number, label: string): void {
  if (!Number.isFinite(level) || level <= 0 || level >= 1) {
    throw new AnalysisError('domain', `${label} must be within (0, 1)`);
  }
}

/** A non-negative integer count. */
export function assertCount(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AnalysisError(
      'domain',
      `${label} must be a non-negative integer`,
    );
  }
}
