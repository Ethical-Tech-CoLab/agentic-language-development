# Lifetime-charge reconciliation supplement v1

- classification: research-supplement (not a research finding; `researchFinding: false`, `scientificDisposition: not-tested`)
- supplementVersion: v1
- handoff: H4 (HANDYM), prospective interpretation supplement; append-only companion to the v1 records below
- supplements (read, not modified):
  - `reports/research/research-attempt-inventory.v1.json` (`sourceCommit 04ef2ca`, OLD hash; see source map)
  - `reports/research/research-resource-balance.v1.json` (measured 2026-09-27T16:00:56Z)
  - `reports/research/iteration-accounting-deviation.v1.md` (Entry 1, source commit `04ef2ca`, OLD hash)
- writtenAgainst: `feat/verifiable-core @ 0eb4e84` (post-purge tree; tip tree identical to pre-purge tip `15d0fb3`)
- status: INTERPRETATION ONLY. This supplement classifies attempts from contemporaneous
  terminal evidence and reconciles what charges can and cannot be derived. It grants no
  exemption, resets no budget, re-ADMs no allowance, and is not the prospective
  authorization the deviation record requires. Unknown stays blocking.

## 1. Old-to-new source map (history purge of 2026-09-27)

The branch history was rewritten after R01. The three commits named by the task
are the R01 tip stack; their messages, authors, dates, and trees are unchanged —
only hashes changed (parent-hash cascade after an upstream purge):

| old (pre-purge, in bundle) | new (post-purge, checked out) | subject |
|---|---|---|
| `15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc` | `e6d5da0de6a79286bc32f42c89d8e7217bd29adf` | docs(research): reconcile LV01 attempt and resource ledger (R01) |
| `04ef2caa28ca12f2f628944d212f938f2c72fdbc` | `fdbf29b1d1fe4807b4decc42d1c39a5df4e9573b` | feat: deferred core R12/R13 — future LV02 and LG01 protocol drafts |
| `9fe8f29c0dce8fd888b1881bb2f3a4d82675da82` | `9be6e536de2f2b32ee9e4d98b492d3a8a931297e` | feat: parallel batch R03/R11/R02docs — v2 protocols, manuscript scaffolding, ledger diagnosis |

Purge characterization (verified by paired old/new `rev-list` tree comparison,
500 commits each side):

- First content divergence from root: `6bda0047…` (old) vs `8168ab9e…` (new),
  both "docs: plan research execution readiness": the 78-line historical presence
  of `plans/completion-plan.md` was removed from the old chain. 69 positions carry
  tree differences across the affected span; all later commits differ by parent-hash
  cascade only.
- Both tips (`15d0fb3`, `e6d5da0`) lack the file; `git diff 15d0fb3 e6d5da0`
  (and the `04ef2ca`/`fdbf29b1`, `9fe8f29`/`9be6e53` pairs) is empty: 1224 files
  each side, identical trees.
- Citation rule: v1 records citing OLD hashes (inventory `sourceCommit 04ef2ca…`,
  deviation "measured against `04ef2ca`", detector-v3 `sourceCommit 110572a…`)
  resolve through the pre-purge bundle
  (`/tmp/ald-pre-purge.bundle`, refs `feat/verifiable-core @ 15d0fb3…`,
  `main @ feb68708…`, `fork/main @ d1b4eabc…`; see the preservation-manifest spec).
  New citations use NEW hashes. No record is re-pointed retroactively.

## 2. Lifetime policy (unchanged, restated for classification)

- Allowance: **five development iterations**, v1 seed/resource policy
  (`protocols/lv01-seed-resource-policy.v1.json`, `stages.development.maxIterations: 5`)
  carried into v2 (`protocols/lv01-seed-resource-policy.v2.json`,
  `stages.development.maxIterations: 5`) with an explicit non-renewal boundary:
  "The five-iteration lifetime allowance is not renewed; retained development-v2
  through development-v23 directories keep their lifetime classifications."
- The v2 amendment (`protocols/lv01-direction-amendment.v2.json`) amends or creates
  only its five listed v2 files; "No other protocol, receipt, raw record, or source
  file is changed by this amendment." It does not reset history (deviation Entry 1).
- All 23 `protocols/lv01-development-resource-allocation.v*.json` packets declare
  `smallFixture.iteration = 1`, and `scripts/check-lv01-development-allocation.mjs:33`
  requires exactly that value — so v23 passes the checker while lifetime compliance
  is unestablished (audit finding A09 P1; `plans/research-direction-audit.md:42`).
- Per-packet small-fixture caps (each allocation): 0.25 CPU-hours, 1 GiB additional
  storage, 6 GiB maximum resident. These are caps, not measured charges.

## 3. Attempt classification from contemporaneous evidence

Classes below are read off retained terminal files and contemporaneous research
records only. Every entry keeps `scientificDisposition: not-tested`; no class implies
a scientific result, and no class excuses a resource charge.

### 3.1 Development family (v1–v23; the five-iteration allowance applies here)

| version | terminal evidence (contemporaneous) | proposed lifetime class | charge status |
|---|---|---|---|
| v1 | allocation only; no evidence dir; v2 protocol states v1 superseded unused | allocation-only unused slot | no execution charge; slot consumed, not an iteration |
| v2 | `fixture-failure.json` stage=configuration (ENOENT learner contract); no Docker launch | pre-execution failure (no fixture run) | retained 517 B; no CPU/working record |
| v3 | `fixture-failure.json` stage=container-execution (witness signer rejected identity before controller execution); no controller turn | executed container attempt, failed before controller turn | retained 3,162 B; no CPU/working record |
| v4 | `fixture-failure.json` stage=container-execution (`docker compose up` failed); `failure-analysis.json` not-tested | executed container attempt, failed | retained 201,549 B; no CPU/working record |
| v5 | `fixture-aborted.json` attemptStatus=aborted stage=launcher (config written, no containers/results); ordinary 2-turn controller output is not an LV01 result | pre-execution abort (launcher) | retained 452,790 B; no CPU/working record |
| v6 | `fixture-failure.json` stage=result-validation (compose did not forward controller stage; ordinary 2-turn path, no LV01 fixture result) | executed container attempt, failed (no LV01 result) | retained 452,837 B; no CPU/working record |
| v7 | `output/lv01-fixture-result.json` state=sealed (64 train/24 eval, 11 ckpts) + `offline-verification.json` all true; `lv01-development-v7-fixture-receipt.json` completed-limited-development-fixture | **development-iteration candidate (sealed)** | retained 3,400,426 B; NO resource sample file → CPU/working unknown |
| v8 | NO terminal file (no result/failure/receipt/verification); only initial bundle + run-config; v9 record describes sampling abort | abandoned start, missing terminal — UNKNOWN | retained 466,410 B; consumption unknowable; blocking |
| v9 | sealed fixture-result (64/24, 12 ckpts) + verification all true + `lv01-fixture-resources.json`; `lv01-development-v9-resource-receipt.json` bounded observation | **development-iteration candidate (sealed)** | retained 4,563,954 B; spot samples only → cumulative CPU/working unknown |
| v10 | NO terminal file; `output/` empty; research record `lv01-development-v10-aborted-attempt.json` status=aborted-collector-defect, "no … resource measurement" | abandoned start, missing terminal — UNKNOWN | retained 3,407 B; consumption unknowable; blocking |
| v11 | `fixture-failure.json` stage=container-execution; research record status=failed-closed-missing-authority-observation | executed container attempt, failed | retained 13,323 B; spot samples only → cumulative CPU/working unknown |
| v12 | `fixture-failure.json` stage=container-execution; research record status=failed-closed-docker-network-capacity | executed container attempt, failed | retained 57,726 B; spot samples only → cumulative CPU/working unknown |
| v13 | `fixture-failure.json` stage=result-validation + `output/lv01-authority-failure.json` (model-adapter-a route assertion); sealed fixture-result SUPERSEDED; research record status=completed-limited-observation-authority-collector-failed, 434 samples | executed full fixture (64/24), failed closed — superseded, must not count as sealed | retained 4,644,346 B; spot samples only → cumulative CPU/working unknown |
| v14 | same as v13 (445 samples; `lv01-development-v14-limited-observation.json`) | executed full fixture (64/24), failed closed — superseded, must not count as sealed | retained 4,637,884 B; spot samples only → cumulative CPU/working unknown |
| v15 | sealed fixture-result (64/24, 12 ckpts) + authority-observation + verification all true; `lv01-development-v15-authority-receipt.json`; NOTE: tabular-path mistake, R02 excludes it from the recurrent set | **development-iteration candidate (sealed)**; R02 eligibility is separate from lifetime counting | retained 4,645,133 B; spot samples only → cumulative CPU/working unknown |
| v16 | sealed fixture-result (64/24, 12 ckpts) + authority-observation + verification all true; R02-eligible sealed recurrent | **development-iteration candidate (sealed)** | retained 6,512,648 B; spot samples only → cumulative CPU/working unknown |
| v17 | sealed (64/24, 11 ckpts) + authority-observation + verification all true | **development-iteration candidate (sealed)** | retained 6,324,648 B; spot samples only → cumulative CPU/working unknown |
| v18 | sealed (64/24, 11 ckpts) + authority-observation + verification all true | **development-iteration candidate (sealed)** | retained 6,481,898 B; spot samples only → cumulative CPU/working unknown |
| v19 | sealed (64/24, 11 ckpts) + authority-observation + verification all true | **development-iteration candidate (sealed)** | retained 6,519,515 B; spot samples only → cumulative CPU/working unknown |
| v20 | sealed (64/24, 11 ckpts) + authority-observation + verification all true | **development-iteration candidate (sealed)** | retained 6,466,987 B; spot samples only → cumulative CPU/working unknown |
| v21 | sealed (64/24, 11 ckpts) + authority-observation + verification all true; parent of sealed paired-v21 | **development-iteration candidate (sealed)** | retained 6,550,618 B; spot samples only → cumulative CPU/working unknown |
| v22 | `preflight-failure.json` (verifyAllocation network mismatch); NO containers started; p0001 slot deliberately NOT created; transcript `check-output.log` | preflight-check failure (no fixture run; single-use gate preserved) | retained 2,725 B (family total); no CPU/working record |
| v23 | sealed fixture-result (64/24, 12 ckpts) + authority-observation + verification all true (checked 2026-09-26); allocation runId `lv01-development-v23-p0001`, net 10.250.185.x/28 | **development-iteration candidate (sealed)** | retained 6,583,383 B; spot samples only → cumulative CPU/working unknown |

Development-family count: **10 sealed iteration candidates** (v7, v9, v15–v21, v23)
against an allowance of 5 — over allowance on the narrowest possible reading (sealed
only), before any treatment of the 6 executed-but-failed attempts (v3, v4, v6, v11–v14
counted as v11, v12, v13, v14 plus v3, v4, v6), the 2 missing-terminal unknowns
(v8, v10), the 3 pre-execution failures (v2, v5, v22), and the unused slot (v1).
No retrospective exemption, renaming, or version reset is permitted to reconcile this.

### 3.2 Dyad family (paired-development v17–v21; outside the development-iteration count, inside resource ceilings)

| version | terminal evidence | proposed class | charge status |
|---|---|---|---|
| v17 | NO study-level paired-case receipt/failure; only branch `compose-output.log` build log; parent development-v17 sealed | missing terminal — UNKNOWN | retained 1,786,022 B; blocking |
| v18 | `paired-case-failure.json` stage=branch:normal (branch compose failed, control-plane network) | executed branch attempt, failed | retained 1,851,941 B; no CPU record |
| v19 | `paired-case-failure.json` stage=branch:normal (branch compose failed, control-plane network) | executed branch attempt, failed | retained 1,867,137 B; no CPU record |
| v20 | `paired-case-failure.json` stage=branch:normal (branch compose failed, baby-a-gateway network) | executed branch attempt, failed | retained 3,959,240 B; no CPU record |
| v21 | `paired-case-receipt.json`: all 7 branches with prediction commitments, actionRecordedAfterPrediction, restoredBeforeAction; not-tested | sealed seven-branch dyad execution (not a study result) | retained 28,387,121 B; no CPU record |

### 3.3 Detector family (v1–v3; measurement qualification, not development iterations; inside resource ceilings)

| version | terminal evidence | proposed class | charge status |
|---|---|---|---|
| v1 | `receipt.json` failure (detector compose failed, controller-scenario exit 137) + pre-attempt runner failure log | executed, failed | retained 58,332 B; no CPU record |
| v2 | `receipt.json` failure (compose failed, exit 1); observations failure (paused≠sealed) | executed, failed | retained 33,734,298 B; no CPU record |
| v3 | `output/lv01-detector-observations.json` failure='evidence RPC timed out'; NO `receipt.json`; raw DB stalled ~turn 1986/2016 (1987 turn_records/channel_events, 3976 policies); torn down 2026-09-27, 0 live handles | executed long observation, failed (missing terminal receipt) — recheck by exact handle read-only per R01-2; no version-bump after timeout | retained 686,397,600 B (largest single attempt); no CPU record |

### 3.4 Fault / lifecycle / safety families (control and fault fixtures, not development iterations; inside resource ceilings)

Sealed (`receipt.json` failure=null passed=true; software qualification only, never a
pilot/behavioral result): application-fault v3 (3,899,908 B), commitment-window-fault v3
(2,675,429 B), five-rejection-safety v1 (2,826,840 B), late-callback v2 (577,930 B),
malformed-proposal v5 (4,037,644 B), recurrent-lifecycle v4 (1,927,652 B).

Failed with terminal `receipt.json` failure: commitment-window-fault v2 (ready-file
timeout; 1,852,326 B), late-callback v1 (controller 1≠0; 201,885 B),
malformed-proposal v1/v3/v4 (compose network-create failures; 4,043,404 / 1,891,683 /
4,033,866 B), recurrent-lifecycle v1/v2/v3 (prepare controller 1≠0; 18,086 / 17,992 /
203,247 B). All executed; none has a CPU record.

Missing terminal — UNKNOWN (blocking): malformed-proposal v2 (1,837,336 B; no receipt
or logs; `output/bundles` holds a STALE bundle for `lv01-development-v21-p0001` —
provenance anomaly to record, not evidence for v2; zero-charge prohibited).

## 4. Charge reconciliation (what is knowable, what is not)

- Retained bytes: MEASURED — `evidence/` 5,527,700,332 B total (`du -sb` re-verified
  this supplement), LV01 857,119,191 B across the families above. Per-family bytes in
  `research-resource-balance.v1.json` stand; v22's 2,725 B is a family dir total
  (preflight transcript, no run dir). On ALDM's preservation copy, retained grows by
  +78,417,499 B (bundle) plus the manifest file; see the preservation-manifest spec.
  New balance versions must re-measure; v1 is not edited.
- CPU-hours: UNRESOLVED — per-attempt CPU exists only as sampled `cpuPercent` spots
  in 13 `output/lv01-fixture-resources.json` files (development v9, v11–v21, v23;
  1 s sampling, e.g. v13: 434 samples from 2026-09-21T21:01:21Z to 21:14:06Z), never
  cumulative cgroup usage. Detector v1/v2/v3 and all paired branches have no CPU
  records. No defensible cumulative charge can be derived; zero-for-missing is prohibited.
- Working/staging peaks: UNRESOLVED — no historical staging/working-peak measurements
  retained; `du` snapshots are post-hoc only.
- Peak memory: PARTIALLY-MEASURED — max sampled container RSS per attempt for the same
  13 run dirs (e.g. v13 93,365,207 B, v14 91,844,772 B); all other attempts unresolved.
  Conservative summed-peak reconciliation requires full-workload calibration (R06).
- Live reserved: MEASURED-ZERO — 0 containers after the v3 teardown; no live study handles.
- External spend: 0 (measured).
- Backups/exports: INCLUDED-IN-RETAINED — no separate backup/export roots located outside
  `evidence/`; export blobs counted once in retained bytes. The prospective preservation
  bundle copy is the first deliberate second root and must be charged (see spec).
- Remaining capacity: UNRESOLVED. Ceilings (72 CPU-hours; 26,843,545,600 B
  retained+working; 6,442,450,944 B resident; 0 external spend) minus unknown charges
  is unknown. No budget reset is available: the v2 amendment does not renew the
  iteration allowance (§2) and no authorization in this supplement creates headroom.

## 5. Unavailability preserved (explicit)

The following are unavailable from contemporaneous evidence and are recorded as
unavailable, not estimated:

1. Lifetime authorization for any attempt beyond the five-iteration allowance (no
   prospective authorization exists in any record).
2. Terminal outcome and consumption of development v8, development v10,
   paired-development v17, malformed-proposal v2 (missing terminals).
3. Terminal receipt for detector v3 (failure observations only).
4. Cumulative CPU-hours for every attempt (spots are not charges).
5. Working/staging peaks for every attempt.
6. Pre-purge citation resolvability without the preservation bundle (old hashes exist
   only in the bundle and rewritten-away objects).

## 6. Gate decision (unchanged)

New experimental collection stays BLOCKED until (a) every attempt has an explicit
lifetime classification within a stated allowance under a prospective authorization
this supplement does not invent, and (b) remaining CPU/storage/memory capacity is
explicit. The classifications in §3 are the reconciled input to that authorization,
not the authorization itself. R02–R05 preparation proceeds; R06 is the first lawful
new-collection launcher.
