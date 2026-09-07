/**
 * Accumulator for the thirteen `VerificationReport.checks` booleans
 * (SPECIFICATION.md §11.10) plus the `gaps` / `forks` lines and the process
 * exit code required by LEDGER-INTEGRITY-DESIGN.md §14 item 12.
 *
 * Every check starts optimistic (`true`) and is only ever turned off, so a
 * check that reads `true` in a report means "this rule was evaluated and held
 * everywhere it applied". `unanchoredTailReported` is the one inverted flag:
 * it starts `false` and becomes `true` when a tail past the last confirmed
 * anchor was found and reported (LEDGER §17).
 *
 * `gaps` lines always start with a kebab-case failure code so a report is
 * machine-readable and not just free text (BACKLOG ALD-017), except for chain
 * violations, which are rendered by `formatChainViolation` and already carry
 * their own `ChainViolationCode`.
 */
import type { VerificationReport } from '@ald/types';

export type VerificationChecks = VerificationReport['checks'];
export type VerificationCheckName = keyof VerificationChecks;

/** Check order used by the report and the CLI summary. */
export const CHECK_NAMES: readonly VerificationCheckName[] = [
  'canonicalJsonValid',
  'sequencesStrictlyIncreasing',
  'entryHashesRebuilt',
  'previousEntryLinksValid',
  'writerSignaturesValid',
  'merkleRootsRebuilt',
  'inclusionProofsValid',
  'consistencyProofsValid',
  'checkpointHashesRebuilt',
  'witnessSignaturesValid',
  'anchorTxConfirmed',
  'anchorChainIdMatches',
  'unanchoredTailReported',
];

/**
 * Note appended to a gaps line whose failure was downgraded by
 * `--allow-unanchored`: the local integrity chain still verified, but the
 * evidence carries no external anchor for that suffix (LEDGER §1).
 */
export const ALLOWED_UNANCHORED_NOTE =
  '(allowed by --allow-unanchored; local integrity only)';

export interface FailOptions {
  /** `false` keeps `exitCode` at 0 (used only by `--allow-unanchored`). */
  escalate?: boolean;
}

export class VerificationAccumulator {
  private readonly state: Record<VerificationCheckName, boolean> = {
    canonicalJsonValid: true,
    sequencesStrictlyIncreasing: true,
    entryHashesRebuilt: true,
    previousEntryLinksValid: true,
    writerSignaturesValid: true,
    merkleRootsRebuilt: true,
    inclusionProofsValid: true,
    consistencyProofsValid: true,
    checkpointHashesRebuilt: true,
    witnessSignaturesValid: true,
    anchorTxConfirmed: true,
    anchorChainIdMatches: true,
    unanchoredTailReported: false,
  };

  private failing = false;

  readonly gaps: string[] = [];
  readonly forks: string[] = [];

  /** Records an informational or failing line without touching a check. */
  gap(code: string, detail: string): void {
    this.gaps.push(detail.length === 0 ? code : `${code} ${detail}`);
  }

  /** Turns one check off and records the reason. */
  fail(
    check: VerificationCheckName,
    code: string,
    detail: string,
    options: FailOptions = {},
  ): void {
    this.state[check] = false;
    this.gap(code, detail);
    if (options.escalate !== false) {
      this.failing = true;
    }
  }

  /**
   * Failure with no boolean of its own in SPEC §11.10 — cross-bindings
   * (LEDGER §6), configuration-hash bindings, structural bundle defects. The
   * report carries it in `gaps` and raises the exit code.
   */
  failStructural(code: string, detail: string): void {
    this.gap(code, detail);
    this.failing = true;
  }

  /** LEDGER §15 fork: two entries claiming the same stream and sequence. */
  fork(line: string): void {
    this.forks.push(line);
    this.failing = true;
  }

  /** LEDGER §17 unanchored final ledger tail. */
  markUnanchoredTail(allowed: boolean): void {
    this.state.unanchoredTailReported = true;
    if (!allowed) {
      this.failing = true;
    }
  }

  /** Marks every check unverified; used when a bundle cannot be opened. */
  markAllUnverified(): void {
    for (const name of CHECK_NAMES) {
      if (name !== 'unanchoredTailReported') {
        this.state[name] = false;
      }
    }
    this.failing = true;
  }

  isFailing(): boolean {
    return this.failing;
  }

  exitCode(): 0 | 1 {
    return this.failing ? 1 : 0;
  }

  checks(): VerificationChecks {
    return { ...this.state };
  }
}
