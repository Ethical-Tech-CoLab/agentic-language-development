# Run accounting (skeleton)

Status: **shells only**. Rows populate from the R01 attempt/charge inventory
and R05 terminal accounting as stages execute. This file reconciles
planned/attempted/valid/invalid/aborted/unattempted counts; it never supplies
empirical estimates.

## Sources (binding)

- Attempt identity (attempted/terminal/unattempted per directory/allocation):
  the R01 inventory files. This file cites them; it does not re-inventory.
- Terminal states and failure evidence: R05 accounting and stage receipts.
- Development, failed, and superseded records: accounting entries only, per
  `docs/data-and-claim-inventory.md`. Their presence never promotes them to
  estimates.
- Iteration allowance: the historical allowance is not renewed. If
  reconciliation shows it exhausted, record the deviation and the exact
  additional bounded allowance required, and stop new collection until a
  prospective authorization exists.

## A1. Stage allocation/attempt table — shell

| Stage | Allocation (dyads/seed domain) | Planned | Attempted | Valid | Invalid | Aborted | Unattempted | Evidence path + digest |
|---|---|---|---|---|---|---|---|---|
| R06 calibration | `TBD` | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| R07 pilot (20 dyads) | `TBD` | 20 | TBD | TBD | TBD | TBD | TBD | TBD |
| R08 lock (no collection) | — | — | — | — | — | — | — | packet hashes `TBD` |
| R09 main (N=`TBD`) | `TBD` | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| R10 repeat (N=`TBD`, fresh seeds) | `TBD` | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

Reserves: primary/reserve disposition `TBD`. Every reserve use cites its
prospective authorization; unauthorized reserve use is a deviation (§A3) and
blocks the affected stage.

## A2. Failed-development accounting — shell

All failed development stays visible here with its terminal receipt. Known
series to reconcile (non-exhaustive pointers; R01 inventory governs):

| Series | Disposition | Terminal receipt |
|---|---|---|
| `evidence/lv01/development-v*` (calibration/development attempts) | `TBD` per-attempt from R01 | `TBD` |
| `evidence/lv01/detector-v1`, `detector-v2` (+ runner failure log) | superseded/development | `TBD` |
| `evidence/lv01/detector-v3` | **sibling-owned, live-observed read-only; do not touch** | — |
| `evidence/lv01/*-fault-*`, `late-callback-*`, `malformed-*`, `paired-*`, `five-rejection-safety-*` | `TBD` per-attempt from R01 | `TBD` |
| E02 v1/v2 (failed before analysis) | failed qualification, retained | `reports/research/e02-v1-failure-analysis.md`, `reports/research/e02-v2-failure-analysis.md` |

## A3. Deviation log — shell

| Date | Stage | Deviation | Prospective authorization? | Disposition |
|---|---|---|---|---|
| `TBD` | `TBD` | `TBD` (e.g. exhausted allowance, invalid input boundary, missing evidence, power failure, unaffordable N) | `TBD` | `TBD` |

Rule: stop the affected execution on any listed deviation. Keep safe
diagnosis and report preparation moving. Never launch amended runs under the
same claimed iteration.

## A4. Resource reconciliation — shell

| Item | Planned | Measured | Remaining |
|---|---|---|---|
| Iteration allowance consumed | TBD | TBD | TBD |
| Peak memory (conservative ×1.5 provisioned) | TBD | TBD | — |
| Retention space for sealed inputs | TBD | TBD | TBD |
| Analysis/reproduction/packaging allocation | TBD | TBD | TBD |

No deadline estimate until measured full dyads exist.
