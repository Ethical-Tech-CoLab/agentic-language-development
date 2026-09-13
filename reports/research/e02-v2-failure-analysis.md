# E02 v2 Supplemental Failure Analysis

**Date:** 2026-09-13  
**Attempt:** E02 v2  
**Disposition:** Failed software qualification; no scientific result

## Recorded outcome

The second prospective E02 qualification attempt failed in slot 1 during
before-restore collection. It completed 161 turn records (indices 0–160), retained
324 delivered adapter observations, and committed 162 accepted channel events. It
did not reach either restore stage, any leakage-probe report, sealing, or final
export. Four registered slots were not attempted.

The terminal slot record reports one 1,000 ms deadline exceedance, one dropped
response, no host error, and no safety event. Both turn-161 observations were
delivered; the sender event, receiver interpretation, and receiver action-side
ledger writes were committed, but no turn-161 record exists. This sequence localizes
the escaped timeout to the post-action turn path. The original error did not persist
the exact method, so method identity remains an inference rather than a recorded fact.

The outer collector then failed while asserting that the slot had no failure. That
wrapper assertion explains why the terminal receipt contains zero completed slot
summaries; it is secondary to the recorded deadline failure and does not erase the
partial slot evidence.

## Engineering implication

The earlier correction removed the nested timer race for `act()`, but the runtime
still allows a deadline from other turn-path methods to escape without a forfeited
turn record. This contradicts the platform rule that a turn deadline becomes an
audited timeout rejection and forfeited turn. The next candidate must cover
`observe`, `receive`, and `onOutcome` deadlines as well as sender and receiver
`act()`, retain the fixed schedule, and preserve the five-consecutive-rejection
safety pause.

Any correction requires development-only fault fixtures, a fresh topology
qualification, a new E02 packet version, new run identifiers, and a new seed domain.
The v2 attempt and seeds must never be restarted or reused.

## Verification

The portable check validates tracked packet, binding, receipt, and supplemental
interpretation bytes:

```sh
corepack pnpm audit:e02-v2-failure
```

Where ignored evidence is retained, the live check also validates raw digests,
database counts, turn-161 ordering facts, resource measurements, and the absence of
restore/probe completion:

```sh
corepack pnpm audit:e02-v2-failure:live
```

## Claim boundary

This analysis establishes the terminal evidence sequence and a bounded engineering
diagnosis. It does not establish E02 qualification, leakage bounds, language
emergence, a negative scientific result, independent review, or a public timestamp.
