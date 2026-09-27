# R05.2b-ii collector interim review (HANDYM, read-only)

Basis: live uncommitted diff at `0eb4e84` + worktree (948-line `lv01-collector.ts`, 438-line test, collect/audit scripts, 126-line diff across 6 files). Interim: ALDM has not frozen R05.2b-ii; recheck everything at freeze. No code touched, no tests run.

## Closes nothing yet, but real structure

- Treatment batch commits before any branch runs; served-vs-peeked stateHash checked per branch; cutoff checked per branch; live slice-token gating per branch; full seven-branch audit replay from bundles with journal-vs-replay commitment equality.
- Stage walk journals every transition, ordered reserves only (prefix of pool, one per invalid primary), finalizes on every path.
- CLI now wires collect/audit behind requireBinding/requireAdmission/requireCollection instead of intentional-fail stubs. Ordinary predictor fixed to `uniform` at collection with analysis-time selection explicitly deferred — correct per plan.

## Open gates (all confirm coordination §6; none newly closed)

- A3 scientific schedule: OPEN. `peekLv01BranchTarget` serves episode 0 of the generic `evaluation` split — prohibited by `lv01-study-design.v2.json`. Turn-0 only, baby-b receiver hard-required. No `generateLv01Case`, no 3000/240/240/240 balanced materialization, no cross-partition uniqueness check.
- A4 paired treatment: OPEN. `buildLv01TreatmentCases` builds two cases sharing one peeked target; the "derangement" swaps selections between branch-copies of the same target, not across distinct scheduled cases within role. `verifyLv01TreatmentTargets` is called with peek-derived (not served-derived) targets, so it checks batch self-consistency only.
- A5 whole dyad: OPEN. `lv01WorkloadForCollection` executes small-fixture only and fails closed otherwise; its comment says full workloads "need the production transport" — the v2 design requires the Prototype worker, never a silent switch to production transport. One parent bundle feeds every slot (fixture-only, never independent N). `lv01ParentCheckpointHash` takes the max-sequence manifest — audit-time maximum, rejected by coordination §5.1; bind the packet-selected checkpoint instead.
- A6 live integrity: OPEN. Executor runs branches in fixed plan order (no permutation/replay check); no snapshot-neutrality or checkpoint-block replay demonstration in this path. Draw-scope stage enum still carries `shadow`/`generalization` while `scopeStageFor` rejects confirmatory/replication — reconcile with canonical stage IDs per §5.3.
- A7 failure accounting: OPEN. Failure terminal captures all-zero resources (line ~809: zeros, not unresolved) and `peakBytes` is final RSS, not peak. Both exactly what the gate forbids.
- A8 chain: PARTIAL. collect/audit wired; reduce-pilot/lock-design/status still stub. Minor: `lv01.mjs` demands `--database-path` while `collect-lv01-stage.mjs` treats it as optional — pick one contract.

## Questions for ALDM (not verdicts)

1. Policy refs are hardcoded to `policies/baby-*-latest.json` inside the sealed parent bundle. Per §5.2 that is acceptable only with the checkpoint binding — is the binding to the packet-selected (not max-sequence) checkpoint verified before these refs are trusted?
2. `nursery-runtime.ts` now accepts multi-symbol deliveries and reduces to `symbols[0]` for the random branch. Is variable-length-draw-then-truncate the registered random-branch behavior, or should the runtime reject what the design does not describe?
3. `auditLv01Stage` reads `treatment-batch.json` (a collector-written file) as the batch input. Which raw-record cross-check makes the audit independent of that file? If none, rebuild or verify it from branch run-configs before trusting it.
4. `void binding;` in `collectLv01Stage` — binding verified but unused. Intended, or is a binding-vs-packet consistency check owed here?
