# Review package skeleton

Status: **skeleton only**. Populates after R09/R10. Internal critique lives
here; it is never labeled independent human review.

## C1. Claim-to-evidence appendix — shell

Every number in `first-paper-draft.md` and `estimates-and-intervals.md` needs
one row. Numbers without a row are removed from the manuscript.

| Claim ID | Manuscript location | Statement | Evidence path | Digest | Verdict |
|---|---|---|---|---|---|
| M-DESIGN | draft §5.1 | LV01 v2 design/analysis/seed-profile/amendment packets are the frozen R03 design record (commit `9be6e536`); self-declared draft-not-registered, authorizing no run | `protocols/lv01-study-design.v2.json`, `protocols/lv01-analysis-plan.v2.json`, `protocols/lv01-seed-resource-policy.v2.json`, `protocols/lv01-prototype-execution-profile.v2.json`, `protocols/lv01-direction-amendment.v2.json` | `8fa62f2d…`, `87be303e…`, `2c3c483c…`, `3880e72b…`, `8d661ca1…` (full SHA-256 in §5.1) | frozen-design (not empirical) |
| M-TASK | draft §5.2 | Task/partition, learner-hyperparameter, and channel facts as stated | `protocols/lv01-study-design.v2.json` (§§task/learner/channel) | `sha256:8fa62f2d8b32f2dfadf0db6450e4687dd9bb85e93824afbb4827edb345cb4743` | frozen-design (not empirical) |
| M-EXEC | draft §5.3 | Prototype execution/separation/retention/commitment/draw/branch/audit rules as stated; logical separation only, no side-channel claim | `protocols/lv01-prototype-execution-profile.v2.json`, `protocols/lv01-study-design.v2.json` (§§execution/evaluation) | `sha256:3880e72bc37ddb6cb94094399bf22dcec327777fb387158e4488590292653c86` | frozen-design (not empirical) |
| M-PRED | draft §5.4 | Ten-predictor set, ordinary-record window/selection/refit, Brier scoring as stated | `protocols/lv01-analysis-plan.v2.json` (§§nativePredictor/predictors/ordinaryRecordWindow/score) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-FAMILY | draft §5.5 | Four-member/seven-component family, margins, Holm/t/inference and invalidity rules as stated | `protocols/lv01-analysis-plan.v2.json` (§§family/invalidity/interpretation) + `protocols/confirmatory-practical-margins.v1.json` (H4 margin lineage) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-SEED | draft §5.6 | Seed derivation, stage rules, six candidate Ns, union-bound selector arithmetic, reserve/repeat rules as stated; locked N and R unselected | `protocols/lv01-seed-resource-policy.v2.json` | `sha256:2c3c483c7b44c3072fa72c2c9f285c14062db75d7ff2d135288ac477edb84d07` | frozen-design (not empirical) |
| M-OC | draft §5.7 | Operating-characteristic simulation cases and ≤0.055 gate as stated; validation receipt pending R06/R08 | `plans/first-publication-implementation-handoff.md` §8 | committed planning source (no receipt yet) | method-specified (not run) |
| M-COST | draft §5.8 | Cost/mutation-challenge methods and global ceilings as stated; all measured values pending R06–R10 | `plans/research-validation-plan.md` §4.5, `plans/first-publication-implementation-handoff.md` §7, `protocols/lv01-seed-resource-policy.v2.json` (§resources) | committed sources (no measurements yet) | method-specified (not run) |
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
| 1 | Trivial fidelity | Is the ledger a restatement of inputs the predictor already had? | TBD (stale-ledger + equal-content controls) | open |
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
