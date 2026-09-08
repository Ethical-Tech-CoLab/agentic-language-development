/**
 * Ledger-claim versus exported-policy consistency check.
 *
 * RESEARCH.md §6.8 requires each track to supply a versioned
 * ledger-to-prediction function at a locked commit, and the reference tabular
 * track supplies exactly that in `@ald/learners`
 * (`predictSenderSymbol`/`predictReceiverChoice`, which read nothing but an
 * exported policy checkpoint). The probe planner's prediction comes from the
 * Baby's ledger events; this module answers a *separate*, diagnostic
 * question: does the same Baby's exported policy put its argmax on the same
 * form for the type code its ledger claims?
 *
 * The check is deliberately non-fatal. SPEC §6.2 lets `exportPolicy()` return
 * any canonicalizable shape, so a policy this module cannot read simply
 * yields `null` (`available: false` inside the schedule) instead of failing a
 * plan. And it is deliberately not part of the prediction: SPEC §15.2
 * validates ledger meanings *behaviourally*, so a policy that disagrees with
 * its own ledger is a finding for the researcher, not a reason for the
 * planner to substitute the policy's opinion.
 */
import {
  parseExportedTabularPolicy,
  predictSenderSymbol,
  tabularPolicyShape,
} from '@ald/learners';

export interface PolicyFormClaims {
  /** True when the policy shape could be read at all. */
  readonly available: boolean;
  /** Which reader matched; `none` when the policy was unreadable. */
  readonly policyShape: 'exported-tabular-policy' | 'none';
  /**
   * Type codes whose sender-side argmax symbol is the claimed form. Empty
   * when the policy never prefers the form for any referent.
   */
  readonly argmaxTypeCodes: readonly number[];
  /**
   * `true` when the ledger's claimed type code is one of them, `false` when
   * it is not, `null` when the policy was unreadable.
   */
  readonly agreesWithLedgerClaim: boolean | null;
}

const UNAVAILABLE: PolicyFormClaims = {
  available: false,
  policyShape: 'none',
  argmaxTypeCodes: [],
  agreesWithLedgerClaim: null,
};

/**
 * Read the type codes an exported tabular policy associates with `form`.
 *
 * Uses only the public `@ald/learners` surface: the policy is parsed and
 * shape-checked, then `predictSenderSymbol` is asked, for every referent type
 * code the policy covers, which form it would emit. Any parse or shape
 * failure — including a policy from a track with a different state shape —
 * returns the unavailable result.
 */
export function readPolicyFormClaims(input: {
  readonly policy: unknown;
  readonly form: string;
  readonly claimedTypeCode: number;
  readonly symbolInventory: readonly string[];
}): PolicyFormClaims | null {
  if (input.policy === undefined || input.policy === null) {
    return null;
  }
  try {
    const parsed = parseExportedTabularPolicy(input.policy);
    const shape = tabularPolicyShape(parsed);
    const argmaxTypeCodes: number[] = [];
    for (let typeCode = 0; typeCode < shape.typeCount; typeCode += 1) {
      const prediction = predictSenderSymbol(
        parsed,
        typeCode,
        input.symbolInventory,
      );
      if (prediction.symbol === input.form) {
        argmaxTypeCodes.push(typeCode);
      }
    }
    return {
      available: true,
      policyShape: 'exported-tabular-policy',
      argmaxTypeCodes,
      agreesWithLedgerClaim: argmaxTypeCodes.includes(input.claimedTypeCode),
    };
  } catch {
    return UNAVAILABLE;
  }
}
