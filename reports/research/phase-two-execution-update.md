# Phase-Two Execution Update: Reliability Qualified, Research Findings Open

Evidence cutoff: 2026-09-15, 15:51 UTC
Status: 3 qualified within bounded software scope; 2 failed qualification attempts retained; 0 running; 16 registered experiment cards unstarted; 8 open campaign blockers.

## Why this milestone matters

The research program asks whether contemporaneous private semantic ledgers add predictive and audit value beyond transcripts, outcomes, policy-state records, and simpler logs. Its experimental platform must first show that agents can run in isolation, evidence survives recovery, and hidden target information is not trivially exposed through the declared observation surface. Phase two addresses that execution reliability; it does **not** answer the ledger-value or language-emergence questions.

| Milestone | Current evidence | What it establishes—and does not |
|---|---|---|
| E00 integrity | Registered five-slot [receipt](e00-integrity-qualification-receipt.json) | Original records verify and retained mutations reject under the registered local integrity scope; no public-chain timestamp or behavioral result. |
| E01 isolation | Registered five-slot [receipt](e01-isolation-qualification-receipt.json) | 560 signed transport/attempt/control records pass the finite isolation corpus; these are not 560 successful blocked attacks or universal isolation. |
| E02 observation leakage and recovery | V3 [terminal receipt](e02-v3-qualification-receipt.json) and separate [full raw audit](e02-v3-full-audit-receipt.json) | Five original numeric scratch-learner slots, before/after-restore stages, and 60 fixed metadata/identifier/timing probe decisions passed unchanged software thresholds. It does not qualify image encoders or establish a behavioral hypothesis. |
| E03 controls and oracle | Staged compiler and six-condition development runner prepared; no E03 run admitted | A next executable development gate exists, but no pilot variance, chance-control qualification, or confirmatory evidence exists. |

## E02 attempt accounting and verification

The first E02 attempt stopped at turn 465 after the registered five-timeout safety pause. The second stopped after 161 committed turns when a post-action deadline escaped without its required forfeited-turn record. Neither reached recovery or probes; four slots in each allocation were unused. Their receipts, partial raw records, and analyses remain retained as failures. They were not restarted or reclassified.

The prospectively amended v3 attempt used five fresh identifiers under registration hash `sha256:d35e6b118e4c811f80b426680a0b2f4b0c9b8da3e59bdc56293e557ef979f248` and exact execution commit `9ec08ecf4528c6da8867d55900d6ca8667ded7ce`. The one sequential service completed all five slots. Each slot retained one real runtime/database close-and-reopen recovery and 12 fixed role/stage/probe reports. All 60 reports passed with 502–503 held-out rows each; the largest recomputed probe upper accuracy bound was 0.340 and the smallest planted-control lower bound was 0.995. Those are bounded leakage-diagnostic measurements on this numeric local topology, not evidence of general absence of leakage or emergent communication.

The host controller first rechecked each sealed slot with the TypeScript verifier, retained Rust auditor, estimator replay, and R-bound references before issuing the terminal receipt. A **separate first-party live audit** then recomputed all five original slots and 60 probe reports and exited successfully. Its supplemental receipt binds the unmodified terminal receipt by SHA-256 (`a628f5af…fd830f3`), the execution commit, audit source commit, command, counts, and zero-spend classification. This is reproducible from retained raw evidence; it is not independent human reproduction.

The registered attempt took 41.66 hours sequential wall time and retains about 734 MiB across five original slot directories. Recorded Nursery cgroup CPU summed to about 1.35 hours, with per-slot Nursery memory peaks of about 0.52–0.59 GiB. Those figures exclude full learner-container, Docker-daemon, and separate-audit CPU accounting, so they cannot by themselves justify the later campaign envelope. The frozen 140-bundle historical inventory remains separate from these five later qualification bundles. No bundle is admitted to a behavioral estimate.

The local simulated commitments spent no funds and recorded no public-chain transaction. They test deterministic binding and local integrity, not independently witnessed time or economic finality. Probe values came from actual runs; no imaginary outcome was substituted.

## Decision and next gate

The [current machine review](../../protocols/campaign-readiness-review.v1.json) closes reliability finding B16 on the v3 terminal and full-audit evidence. E02's attempt is **completed**, its qualification execution gate is **complete**, and its scientific disposition remains **not tested**. The remaining eight blockers include pilot/design power, exact packets, selected-topology/resource qualification, carrier and causal-comparator execution, and authentic independent review. Publication readiness remains unestablished.

E03 now moves to a **pilot-stage** progression gate. Its development-only six-condition topology must run and pass original bundle verification, paired-scenario checks, isolated role-container accounting, simulated anchors, and measured resources. Only then may a prospectively activated 120-run blinded pilot be considered under an explicit local allocation. Missing pilot variance is a gate for selecting the later full qualification sample size—not a precondition for collecting that pilot. A pilot result will not enter confirmatory estimates, and a valid null or control failure will be reported without relabeling it as a crash.

The terminal receipt and current-status checks work from tracked files after this update. Re-running `corepack pnpm@12.3.4 run audit:qualification-e02:live` requires the separately retained, Git-ignored `evidence/qualification/e02-v3/` directory. Nothing in this update authorizes external spending, deployment, submission, or a claim of independent review.
