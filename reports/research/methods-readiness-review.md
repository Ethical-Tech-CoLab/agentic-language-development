# Campaign Methods and Registration Readiness Review

Review date: 2026-09-13
Review type: internal adversarial methods review  
Decision: not registration-ready  
Independent human review: not performed

## Decision

Research status: 2 qualified (software), 2 failed qualification attempts, 0 in progress, 16 not started; 9 open campaign blockers.

All 19 experiment cards are covered. E00 completed its registered software
qualification and E01 v2 closed B15 with signed explicit-corpus evidence. E02 v1
stopped at its safety pause before restore or analysis. E02 v2 then stopped after
161 recorded turns when one post-action turn-path deadline escaped without a
forfeited turn record or safety event. Both attempts remain failed; 16 other
experiments await prerequisites. The
machine-readable decision is `protocols/campaign-readiness-review.v1.json`. This
review is deliberately fail-closed: repository implementation, complete tests, and
software qualifications do not substitute for repository registration, prospective
commitments, selected sample sizes, or adequate resources. Independent review
remains necessary for claims of independent scrutiny and later publication readiness. The
scoped governance and simulation-only funding decision is now complete.

The existing work is internally coherent enough to continue safe local engineering,
historical evidence inventory, report preparation, detector/comparator qualification,
and bounded software exercises. It is not coherent to launch a confirmatory run or
to relabel any existing fixture as a pilot.

## Critical blockers

1. No confirmatory protocol has a complete canonical packet, immutable repository
   registration, and identical verified pre-run simulated commitment.
2. No blinded pilot has supplied the variance and feasibility inputs needed to select
   exact confirmatory seed prefixes. N=100 is planning-only.
3. E02 v1 stopped after repeated response timeouts triggered the safety pause. V2
   corrected the nested deadline race but exposed an uncovered post-action timeout
   path. The current candidate supplies the same audited forfeit behavior across all
   turn-path methods, but fresh topology qualification must pass before v3 can be
   registered with fresh seeds.
4. Maximum pools project to 855.9 GiB and 375.7 single-core hours before
   frozen-model overhead, above the authorized 25 GiB/72-hour,
   zero-spend local ceiling.

## Major design and implementation blockers

- E13 now has an exact synthetic qualification for handcrafted bitmap, canvas, and
  tone distance plus held-out nearest-prototype scoring. Twenty-eight structural
  dimension, metadata, raw-media, sample-rate, compression, and container attacks
  also pass through the real Gateway. It still needs prospective learned-form
  generalization and selected-production-topology negative bounds.
- E15/E16 now have an exact synthetically qualified validation-only comparator core
  for all five non-ledger baselines. The production runtime commits per-turn baseline
  and native predictions after delivery but before receiver action, then binds scores
  to the hash-recorded action/outcome. The run configuration binds the selection
  commitment, native prediction-function version, and accepted-delivery eligibility,
  and fails closed on restart. Exact production qualification passed; eligible
  registered execution and aggregate analysis remain absent.
- E01 v1 passed five independently recreated slots on its exact registered
  two-container topology, including timing/envelope/error, host, network, Gateway,
  and detector-positive controls. V2 then passed five prospectively registered fresh
  slots with all 560 explicit attempt/control records signed and checkpointed;
  both verifier implementations accepted the original bundles, closing B15.
- A fail-closed canonical packet compiler rejects missing, extra, empty, and
  placeholder operational fields. E00 and E01 retain usable packets; the failed E02
  v2 attempt consumed its packet and seeds. The remaining 16 cards have 160 unresolved
  exact bindings, and E02 requires a fresh v3 packet.
- Independent restore, methods/statistics review, reproduction review, hosted
  enforcement, and load-bearing citation re-review remain optional external evidence
  gaps. They do not block local collection, and no corresponding independent claim is made.

## Per-experiment disposition

| Experiment | Ready | Immediate blocking chain |
|---|---|---|
| E00 | Yes | V5 passed its prospectively registered five-slot software-qualification gate |
| E01 | Yes | V2 passed the prospective five-slot explicit corpus with signed evidence; bounded software qualification only |
| E02 | No | V2 failed after 161 recorded turns; the all-method deadline repair has development coverage but requires fresh topology qualification before a v3 packet can be registered |
| E03 | No | E02 qualification, blinded pilot, selected N, exact packet; E01 is satisfied |
| E10-E16 | No | upstream experimental dependencies, resources, selected N where confirmatory, missing carrier/comparator qualification |
| E20-E22 | No | E16, resources, selected N and topology leakage qualification where applicable |
| E30-E32 | No | upstream experimental chain, resources, and repository registration |
| E40 | No | E32, resources, and exact packet |
| E50 | No | completed designated studies plus repository registration and resources |

## Safe continuation boundary

Local work may build the historical data/claim inventory, anonymous report and
registration templates, missing synthetic detector/comparator qualifications, and
additional bounded software evidence. It may not collect confirmatory outcomes,
spend externally, transact on mainnet, invent approval/third-party-registration/review receipts,
or present qualification output as a research finding.

This decision remains open rather than “resolved by prose.” Each blocker has a
specific closure test in the machine review. D08 remains in progress until those
tests are met or the affected scientific scope is prospectively narrowed and the
consequences are recorded.
