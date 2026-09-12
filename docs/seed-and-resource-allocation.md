# Seed and Resource Allocation

Status: D07 allocation policy frozen; no pilot or study outcome

The machine-readable source is
`protocols/seed-and-resource-allocation.v1.json`; the generated audit receipt is
`reports/research/seed-resource-ledger.json`.

## Disjoint seed domains

Software qualification, blinded pilot, confirmatory, and replication each use a
different domain in a NUL-separated SHA-256 derivation. Within a stage, experiment,
and slot, paired conditions share the scenario seed but have different learner,
Gateway, and analysis seeds. The two learner roles also have different seeds. The
audit exhaustively derived 27,190 planned seed values and found no collision.

Software-qualification seeds cannot estimate effects or variances. Pilot seeds can
estimate feasibility and the variance used to choose N, but cannot enter a
confirmatory estimate. Replication seeds have a separate domain and cannot overlap
either. An invalid primary run can use only the next ordered reserve, and both remain
in the index.

Each experiment receives at most five development iterations and five qualification
seeds per condition per iteration. Development uses training and validation data;
held-out test data is accessed once. A blinded pilot may select the primary and
ten-percent reserve counts. It may not tune architecture, outcomes, practical
margins, directions, splits, or exclusions.

## Sample-size decision

The global family contains nine members: H1-H8 with H2 and H4 separate. The shared
candidate grid is 25, 50, 75, 100, 125, 150, 200, and 300 independent seeds. For
each member, the frozen raw-scale practical margin and blinded-pilot upper variance
bound feed a 30,000-repetition simulation of the complete statistic, any composite
rule, missingness, and global Holm correction. The smallest shared N whose lower 95%
Monte Carlo all-required-decisions power bound is at least 0.90 is selected before
unblinding. The present N=100 is a resource-planning value based on the already
validated standardized-effect-0.40 family case, not a final sample-size finding.

If no candidate through N=300 qualifies, the margin cannot be widened. The affected
study remains unregistered until a prospective redesign or a larger approved
resource envelope exists.

## Measured resource model

A fresh five-carrier software qualification executed 260 turns in 37.58 seconds at
about one CPU, peaked at 264,896 KiB RSS, and wrote 25,532,466 bytes in 15,695 files.
The observed planning rates are 98,201.79 bytes per turn and 7.516 wall seconds per
short run. This measurement includes build startup, local fake-chain work, and
verification; it does not estimate frozen-model latency or any prohibited public-chain latency or
distributed throughput.

The maximum materialized pools contain 9,171 bundles and 9,358,100 turns, including
2,750 provisional replication bundles. Linear projection at the measured recurrent
rate is 855.9 GiB uncompressed and 375.7 single-core hours. These are upper-pool
planning figures, not instructions to execute unused seed suffixes. Selected E03 and
confirmatory prefixes will reduce them, while real frozen-model and external-service
costs can increase them.

The current local authorization ceiling is 72 CPU-hours, 25 GiB working storage,
6 GiB peak process memory, one frozen-model process, and zero external spend. It is
adequate for software qualification and bounded, explicitly non-confirmatory pilots.
It is not adequate for the full campaign. D08 must bind exact selected prefixes,
measured per-experiment costs, an execution host/storage plan, governance,
registration, and anchoring before confirmatory execution.

Run `pnpm run build:seed-resource-ledger` only when intentionally updating the
protocol. The consolidated gate uses `pnpm run audit:seed-resource` and fails on a
stale ledger, a collision, a missing experiment, an accounting mismatch, or any
local external-spend allowance.
