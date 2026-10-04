# Evidence-absent quarantine record (R5-A)

Governance: `plans/decisions.md`, 2026-10-04 ~10:05 UTC (OWLAD, full user
authority). Owner: ALDM. Active quarantines: **7**. This record is the
tracked issue substitute for the test-reliability policy (no GitHub issue
tracker is reachable from the implementing machine: no `gh`, no token).

## Mechanism

Loud skip-if-evidence-absent per check, implemented in
`scripts/quarantine.mjs`:

- A check quarantines ONLY when its evidence probe fails AND a committed
  marker file `quarantine/<name>.json` permits the skip.
- Evidence present always runs the full check, marker or not.
- Evidence absent WITHOUT a marker fails closed through the check's natural
  path (the pre-quarantine red).
- Every skip prints one `QUARANTINED <name>: <reason> | resume: ...` line to
  gate output, naming the marker and this record. The suite-level test
  `scripts/__tests__/quarantine.test.ts` pins the exact set of 7 markers and
  asserts each quarantined unit passes loud.

Reversal (fully reversible): restore the missing evidence (checks
automatically run full again) or delete the marker (checks fail closed
again); then remove the skip branch in a cleanup commit and re-run
un-quarantined. Each marker carries its own `removalCondition`.

## Relation to the test-reliability policy

`docs/test-reliability-policy.md` asks for (1) a tracked issue, (2) a named
owner + removal condition, (3) a separate non-required quarantine job rather
than an inline skip, and (4) no `Done` criterion losing blocking coverage.

- (1) This record + the per-check markers are the tracked issue substitute
  (no issue tracker reachable; see above).
- (2) Owner ALDM; removal conditions in each marker.
- (3) Governance explicitly routed around a separate job: these 7 are not
  flaky tests but environment-absent evidence (empty `evidence/`, absent
  freeze commits, no docker). A separate job would fail identically with no
  added signal, while the inline loud skip reaches green-per-record and
  auto-restores when evidence arrives. Recorded deviation, not an oversight.
- (4) Satisfied vacuously: none of the 7 checks gates an ALD criterion (see
  mapping below), so no `Done` criterion loses blocking coverage; the
  acceptance-coverage evidence map is untouched and still passes.

## Criterion mapping: all 7 are NONE FOUND

The LV01 development-fixture layer is deliberately decoupled from ALD
acceptance: zero `LV01` references in `BACKLOG.md` (verified: `grep -c`
returns 0) or in the conformance matrix gating maps, zero `ALD-[0-9]`
references in any LV01 packet/receipt/check, and every packet/receipt
`claimBoundary` disclaims pilot/behavioral/finding closure. The per-check
thematic neighbours below are informational only — NOT gates — so no
BACKLOG box was noted or unchecked.

| # | Quarantine | Check | Thematic neighbour (not a gate) |
|---|-----------|-------|-------------------------------|
| 1 | `lv01-paired-development-v21` | `audit:lv01-paired-development-v21` | ALD-028 / ALD-029.2 |
| 2 | `lv01-commitment-window-fault-v3` | `audit:lv01-commitment-window-fault-v3` | ALD-010 / ALD-027 / ALD-061 |
| 3 | `lv01-malformed-proposal-v5` | `audit:lv01-malformed-proposal-v5` | ALD-034.1 / ALD-035.1 |
| 4 | `lv01-five-rejection-safety-v1` | `audit:lv01-five-rejection-safety-v1` | ALD-034.2 / ALD-059.1 |
| 5 | `lv01-application-fault-v3` | `audit:lv01-application-fault-v3` | ALD-061 / ALD-055.3 |
| 6 | `lv01-development-allocation-v12` | fixture-runner test, v12 block only (v1/v9 still run) | ALD-082.3 / ALD-023 |
| 7 | `lv01-development-v23-receipt` | v23 receipt test, evidence test only (boundary + 14 mutation tests still run) | ALD-015 / ALD-055 / ALD-059 |

## macOS-only environmental failures (NOT quarantined, NOT product gaps)

These 15 tests require Linux facilities absent on macOS and are expected to
pass on CI (`ubuntu-latest`). Causes quoted from observed errors:

- `scripts/__tests__/a0-launch.test.ts` (9): needs `systemd-run` transient
  units — macOS has no systemd (payload exit code 2 from the missing
  supervisor path). Tests: runs a trivial job to completion and cleans up
  the unit; enforces the deadline and verifies launch readbacks on a live
  job; propagates a failing payload exit code without supervisor error;
  refuses a non-owner without touching the lease; refuses a lease bound to
  a prior policy revision; refuses to launch when the bound receipt changed
  after acquisition; retains a self-signalled payload as completed without
  timeout origin; retains an ordinary near-boundary nonzero exit as
  completed; attributes a systemd RuntimeMaxSec stop as timeout without any
  supervisor sample.
- `scripts/__tests__/a0-preflight.test.ts` (3): needs the `aldresearch.slice`
  cgroup accounting group — observed `enforcement: aldresearch.slice absent
  (accounting group unreadable)`. Tests: establishes the OOM baseline on
  first run, then requires quiet history; reconciles only a matching
  incident with no new OOM kills; refuses a declared workload that cannot
  fit host reserve without a cap.
- `scripts/__tests__/campaign-readiness.test.ts` (3): reads
  `/proc/<pid>/stat` — observed `ENOENT` (no procfs on macOS). Tests:
  accepts a source-bound running pilot only while its exact controller is
  live; rejects a running pilot with a controller start identity mismatch;
  rejects a stale ready pilot status after original collection has started.

None of these files were touched by the quarantine change or the R4-A port.
