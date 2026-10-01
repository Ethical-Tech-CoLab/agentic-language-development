# Review package skeleton

Status: **skeleton only**. Populates after R09/R10. Internal critique lives
here; it is never labeled independent human review.

## C1. Claim-to-evidence appendix — shell

Every number in `first-paper-draft.md` and `estimates-and-intervals.md` needs
one row. Numbers without a row are removed from the manuscript.

| Claim ID | Manuscript location | Statement | Evidence path | Digest | Verdict |
|---|---|---|---|---|---|
| M-Q | draft §1 | Four questions (utility, fidelity, causal-use, cost) + joint rule: a useful-ledger sentence needs LV-U and LV-C support plus native-beats-uniform held-out; LV-C alone covers only the four registered margins | `protocols/lv01-study-design.v2.json` :13 (question) + `protocols/lv01-analysis-plan.v2.json` :52-55,:77-82 (members/Holm :52-55; usefulLedgerPrediction :78; LV-C :81) | digests per §5.1 (`5784f7b5…`, `87be303e…`) | frozen-design (not empirical) |
| M-POP | draft §2 | Dyad unit with dyad-level uncertainty; N=`TBD` main + same-N fresh-seed repeat; 20 pilot dyads select N and are not confirmatory; R05-admission inclusion with R08-frozen exclusions in run-accounting; no human-language sampling, generalization disclaimed | `protocols/lv01-study-design.v2.json` :35-40,:14-19 (partitions :35-40; scopeBoundary :14-19) + `protocols/lv01-seed-resource-policy.v2.json` :40-42 (pilot :40; confirmatory :41; replication :42) | digests per §5.1; N, seed domain, run-accounting `TBD` | frozen-design + TBDs (not empirical) |
| M-ACCESS | draft §3 | Comparator read/must-not-read rows; no stale-ledger row (LV02-T pointer, not an LV01 comparator); trusted-Prototype mode limits with logical separation via allow/block lists and negative cases, no hardware or side-channel claim | `protocols/lv01-analysis-plan.v2.json` :19-45 (native :19-25; predictors :26-37; window + forbidden :38-45) + `protocols/lv01-prototype-execution-profile.v2.json` :15-29,:83 (separation + roleInputs :15-28; separationClaim :29; claimBoundary :83); `protocols/lv02-analysis-plan.v1.json` LV02-T (:1 single-line JSON; family.members + staleness component read 2026-10-01) | digests per §5.1 | frozen-design (not empirical) |
| M-FOUND | draft §4 | Inherited-vs-new table: runtime/learner/channel frozen via R03 with no redesign; ledger machinery none-new; D01–D12 packets plus stated amendments; R04/R05/R09/R10 cells `TBD`; zero research-included bundles at cutoff | draft §5.1 digests (this package) + precedent paths (both exist, headers read 2026-10-01: research-critical-review.md review 2026-09-13 on RESEARCH.md v0.1.121; manuscript-readiness-audit.json captured 2026-09-20); empirical cells `TBD` | §5.1 digests; R04/R05/R09/R10 `TBD` | frozen-design + TBDs (not empirical) |
| M-DESIGN | draft §5.1 | LV01 v2 design/analysis/seed-profile/amendment packets are the frozen R03 design record (original lineage commit `9be6e536`; current bytes include R03-B F1/F2 committed `9c25643` plus seed-vocabulary amendment committed `f4cc224` plus F-R04-1 draw-scope/B1 amendment committed `591c9ce` per §5.1 digests); self-declared draft-not-registered, authorizing no run | `protocols/lv01-study-design.v2.json`, `protocols/lv01-analysis-plan.v2.json`, `protocols/lv01-seed-resource-policy.v2.json`, `protocols/lv01-prototype-execution-profile.v2.json`, `protocols/lv01-direction-amendment.v2.json` (status :6 each; amendment scope/amendedPaths :12-19) | `5784f7b5…`, `87be303e…`, `ff4d0ac0…`, `26211ace…`, `8d661ca1…` (full SHA-256 in §5.1) | frozen-design (not empirical) |
| M-TASK | draft §5.2 | Task/partition, learner-hyperparameter, and channel facts as stated | `protocols/lv01-study-design.v2.json` :26-70 (task :26-44; learner :45-63; channel :64-70) | `sha256:5784f7b5311148a30346b38962947818244a3f982ddeb04809b012a65aaf98f6` | frozen-design (not empirical) |
| M-EXEC | draft §5.3 | Prototype execution/separation/retention/commitment/draw/branch/audit rules as stated; logical separation only, no side-channel claim | `protocols/lv01-prototype-execution-profile.v2.json` :11-78 (runtime :11-30; records :31-38; retention :39-46; batch :47-52; commitment :53-57; draw :58-63; conditions :64-73; audit :74-78) + study-design :71-101 (execution :71-82; evaluation :83-93; observationSchemas :94-101) | `sha256:26211acef67fe352e3dd4a8672b2ad8f9ced8ed5dd0f10199d8614aa0b1302f1` | frozen-design (not empirical) |
| M-PRED | draft §5.4 | Ten-predictor set, ordinary-record window/selection/refit, Brier scoring as stated | `protocols/lv01-analysis-plan.v2.json` :17-51 (target :17-18; native :19-25; predictors :26-37; window :38-46; score :47-51) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-FAMILY | draft §5.5 | Four-member/seven-component family, margins, Holm/t/inference and invalidity rules as stated | `protocols/lv01-analysis-plan.v2.json` :52-85 + :92 (family :52-71; invalidity :72-76; interpretation :77-85; marginLineage :92) + `protocols/confirmatory-practical-margins.v1.json` (H4 margin lineage) | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` | frozen-design (not empirical) |
| M-SEED | draft §5.6 | Seed derivation, stage rules, six candidate Ns, union-bound selector arithmetic, reserve/repeat rules as stated; locked N and R unselected | `protocols/lv01-seed-resource-policy.v2.json` :17-58 (derivation :17-36; stages :37-43; power :44-58) | `sha256:ff4d0ac0f8f8122d917bb7017d12305aeb87b03fc1821218778271c6a9928c58` | frozen-design (not empirical) |
| M-OC | draft §5.7 | Operating-characteristic simulation cases and ≤0.055 gate as stated (working description only); validation receipt pending R06/R08 | Ignored handoff §8 (not authority) + `reports/research/authority-binding-proposals.v1.md` P1 (proposed tracked binding) | no tracked source yet | unbound (not fixed) |
| M-COST | draft §5.8 | Cost/mutation-challenge methods and global ceilings as stated; all measured values pending R06–R10 | Ignored master-plan §4.5 for the benchmark (not authority) + `reports/research/authority-binding-proposals.v1.md` P2 (proposed tracked binding); `protocols/lv01-seed-resource-policy.v2.json` :59-67 (§resources) for ceilings only | ceilings tracked; benchmark unbound | method-partly-unbound (not run) |
| M-ROLE | draft §5.3 | Sender receives private numeric referent cue; receiver/predictors receive no true target label; one observation chokepoint | `packages/scenario/src/referential-engine.ts` (:933-963 payload split) + `packages/scenario/src/observation.ts` (:52-68 chokepoint) | no digest (shell-blocked); re-verify at freeze | implemented-static (read 2026-09-29; re-verified 2026-10-01, no drift; integration run-gated; contract F1 registered) |
| M-KDF | draft §5.6 | Seed derivation is SHA-256 hex over NUL-joined registered parts; derangement seeds registered-form | `packages/hashing/src/prng.ts` (:115-124) + `packages/orchestrator/src/experiments/lv01-ledger-treatments.ts` (:101-124) | no digest (shell-blocked); re-verify at freeze | conformant-static; role-suffix concat (:170-173) registered in derivation.roleStreamSeparation (F2 closed; pointers re-verified 2026-10-01, no drift) |
| M-POWER-IMPL | draft §5.6 | Selector implements candidates/MC-30000/exact rules/Wilson reserves; R↔TS 42-comparison cross-check | `packages/analysis/src/ledger-value-power.ts` (:1-49) + `scripts/validate-lv01-reference.R` + `scripts/check-lv01-power-reference.mjs` | no digest (shell-blocked); re-verify at freeze | implemented-static (read 2026-09-29; re-verified 2026-10-01, no drift; cross-check run-gated) |
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
