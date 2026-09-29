# Review package skeleton

Status: **skeleton only**. Populates after R09/R10. Internal critique lives
here; it is never labeled independent human review.

## C1. Claim-to-evidence appendix — shell

Every number in `first-paper-draft.md` and `estimates-and-intervals.md` needs
one row. Numbers without a row are removed from the manuscript.

| Claim ID | Manuscript location | Statement | Evidence path | Digest | Verdict |
|---|---|---|---|---|---|
| M-DESIGN | draft §5.1 | LV01 v2 design/analysis/seed-profile/amendment packets are the frozen R03 design record (original lineage commit `9be6e536`; current bytes include R03-B F1/F2 committed `9c25643` plus seed-vocabulary amendment committed `f4cc224` per §5.1 digests); self-declared draft-not-registered, authorizing no run | `protocols/lv01-study-design.v2.json`, `protocols/lv01-analysis-plan.v2.json`, `protocols/lv01-seed-resource-policy.v2.json`, `protocols/lv01-prototype-execution-profile.v2.json`, `protocols/lv01-direction-amendment.v2.json` | `a483f25f…`, `87be303e…`, `d3e927b5…`, `26211ace…`, `8d661ca1…` (full SHA-256 in §5.1) | frozen-design (not empirical) |
| M-TASK | draft §5.2 | Task/partition, learner-hyperparameter, and channel facts as stated | `protocols/lv01-study-design.v2.json` (§§task/learner/channel) | `sha256:a483f25f36abe198247b3992df7a7739120c7748ca83c787d01bdf317f34a576` | frozen-design (not empirical) |
| M-EXEC | draft §5.3 | Prototype execution/separation/retention/commitment/draw/branch/audit rules as stated; logical separation only, no side-channel claim | `protocols/lv01-prototype-execution-profile.v2.json`, `protocols/lv01-study-design.v2.json` (§§execution/evaluation) | `sha256:26211acef67fe352e3dd4a8672b2ad8f9ced8ed5dd0f10199d8614aa0b1302f1` | frozen-design (not empirical) |
| M-PRED | draft §5.4 | Ten-predictor set, ordinary-record window/selection/refit, Brier scoring as stated | `protocols/lv01-analysis-plan.v2.json` (§§nativePredictor/predictors/ordinaryRecordWindow/score) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-FAMILY | draft §5.5 | Four-member/seven-component family, margins, Holm/t/inference and invalidity rules as stated | `protocols/lv01-analysis-plan.v2.json` (§§family/invalidity/interpretation) + `protocols/confirmatory-practical-margins.v1.json` (H4 margin lineage) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-SEED | draft §5.6 | Seed derivation, stage rules, six candidate Ns, union-bound selector arithmetic, reserve/repeat rules as stated; locked N and R unselected | `protocols/lv01-seed-resource-policy.v2.json` | `sha256:d3e927b57819029dfe64f2635611cba1cac020bbf929981be3be843c58dd96cd` | frozen-design (not empirical) |
| M-OC | draft §5.7 | Operating-characteristic simulation cases and ≤0.055 gate as stated (working description only); validation receipt pending R06/R08 | Ignored handoff §8 (not authority) + `reports/research/authority-binding-proposals.v1.md` P1 (proposed tracked binding) | no tracked source yet | unbound (not fixed) |
| M-COST | draft §5.8 | Cost/mutation-challenge methods and global ceilings as stated; all measured values pending R06–R10 | Ignored master-plan §4.5 for the benchmark (not authority) + `reports/research/authority-binding-proposals.v1.md` P2 (proposed tracked binding); `protocols/lv01-seed-resource-policy.v2.json` (§resources) for ceilings only | ceilings tracked; benchmark unbound | method-partly-unbound (not run) |
| M-ROLE | draft §5.3 | Sender receives private numeric referent cue; receiver/predictors receive no true target label; one observation chokepoint | `packages/scenario/src/referential-engine.ts` (:933-963 payload split) + `packages/scenario/src/observation.ts` (:52-68 chokepoint) | no digest (shell-blocked); re-verify at freeze | implemented-static (read 2026-09-29; integration run-gated; contract F1 registered) |
| M-KDF | draft §5.6 | Seed derivation is SHA-256 hex over NUL-joined registered parts; derangement seeds registered-form | `packages/hashing/src/prng.ts` (:115-124) + `packages/orchestrator/src/experiments/lv01-ledger-treatments.ts` (:101-124) | no digest (shell-blocked); re-verify at freeze | conformant-static; role-suffix concat (:170-173) registered in derivation.roleStreamSeparation (F2 closed) |
| M-POWER-IMPL | draft §5.6 | Selector implements candidates/MC-30000/exact rules/Wilson reserves; R↔TS 42-comparison cross-check | `packages/analysis/src/ledger-value-power.ts` (:1-49) + `scripts/validate-lv01-reference.R` + `scripts/check-lv01-power-reference.mjs` | no digest (shell-blocked); re-verify at freeze | implemented-static (read 2026-09-29; cross-check run-gated) |
| C-`TBD` | `TBD` §/table/cell | `TBD` (empirical claims populate only from sealed R09/R10 evidence) | `TBD` | TBD | TBD (supported / unsupported / null-as-reported) |

Explicit non-claims (stated in the paper so readers do not infer them):

| Non-claim | Manuscript location |
|---|---|
| No signing-improves-semantics claim | draft §6, estimates T5 |
| No physical-isolation or timing-channel claim | draft §§3, 7 |
| No chronological-development, compositional-generalization, acquisition, or human-language claim | draft §§7–8 |
| No independent-replication claim (repeat is same-team, fresh-seed) | draft §6.8, §C3 below |

## C2. Skeptical-review checklist — shell

Verdict scale per item: `open` / `answered-with-evidence` / `answered-as-limitation`.

| # | Topic | Hardest question | Answer + evidence | Verdict |
|---|---|---|---|---|
| 1 | Trivial fidelity | Is the ledger a restatement of inputs the predictor already had? | TBD (ordinary-record + equal-content controls; stale-ledger is LV02-only) | open |
| 2 | Weak comparators | Is each baseline the strongest fair representative of its information set? | TBD | open |
| 3 | Temporal leakage | Could any predictor have read future information? | TBD (chronology checks + negative cases) | open |
| 4 | Outcome selection | Were all registered outcomes reported from one sealed analysis run? | TBD | open |
| 5 | Logical isolation | Is the field allow/block list enforced, and is no broader isolation claimed? | TBD | open |
| 6 | Seed uncertainty | How do main and fresh-seed repeat compare, stated plainly? | TBD | open |
| 7 | Cost | Is full measured cost shown beside every effect? | TBD | open |
| 8 | External validity | Are acquisition/composition/adversarial/human-language non-claims explicit? | TBD | open |

Prior internal reviews retained as process precedent (not inherited results):
`reports/research/research-critical-review.md`,
`reports/research/manuscript-readiness-audit.json`.

## C3. Repeat and independence status — shell

| Item | Value |
|---|---|
| Repeat design | Fresh seeds, same locked N, unchanged commands (R10) |
| Repeat agreement | `TBD` — state agreement/disagreement plainly, including negatives |
| Same-data reproduction | `TBD` — R10 receipt; tables reproduce from sealed data: yes/no |
| Independence status | Same team and codebase; new seeds. **Not** an independent replication. |
| Independent human review | `TBD` — obtained (cite) or explicitly absent; automated review never relabeled |

## C4. Source and venue audit — shell

- [ ] All bibliography entries resolve; load-bearing citations rechecked
      (`TBD` — human recheck required for load-bearing sources).
- [ ] Venue rules rechecked at manuscript freeze against current official
      TMLR pages (editorial policies, acceptance criteria, author guide):
      anonymous PDF via the TMLR LaTeX template, 100 MB supplementary limit,
      CC BY 4.0 submission material, author profiles/declarations, no parallel
      archival submissions.
- [ ] A venue change, if any, is an explicit later decision on scientific
      scope and actual rules — never an automatic fallback after an
      inconvenient result.

## C5. Release checklist — shell (before any submission)

- [ ] Author agreement, contributions, quota eligibility, conflicts, funding,
      originality, overlap restrictions verified by accountable human authors.
- [ ] AI-assisted development and drafting disclosed; human authors take
      responsibility for all content.
- [ ] Licensing and disclosure review covers CC BY 4.0 submission material
      and data/model release restrictions.
- [ ] Anonymized supporting materials; no public-code-repository
      de-anonymization.
- [ ] Explicit submission authorization recorded (authorization ref: `TBD`).
      Local preparation never implies permission.
