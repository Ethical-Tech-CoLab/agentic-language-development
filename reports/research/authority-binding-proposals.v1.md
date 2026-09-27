# Authority-binding proposals (H3) — tracked homes for plan-hosted methods

Status: **proposal only, 2026-09-27 (HANDYM h3-authority)**. Nothing here is
registered, executed, or measured. Each section proposes one frozen TRACKED
binding for ALDM to implement; manuscript prose sync follows that
implementation, not this file.

## Premise (binding on all four proposals)

`plans/` is gitignored (`.gitignore` `/plans/`, zero tracked files) and
coordinates work only. An ignored plan is not a registration, not evidence,
and not committed scientific authority: it cannot fix a method, authorize a
run, or supply a number. Any method currently fixed only in
`plans/research-validation-plan.md` or
`plans/first-publication-implementation-handoff.md` is UNBOUND until a
tracked protocol/packet carries it. The frozen R03 v2 packets (commit
`9be6e536`) are byte-frozen: corrections land in NEW tracked amendment
files, never as rewrites of frozen bytes. No `main`/`repeat` label is
aliased to development; corrections are prospective only.

Manuscript impact: `reports/manuscript/*` no longer cites `plans/` as
authority (see h3 prose corrections). The draft's §5.7/§5.8 method text is
retained as a working description explicitly marked unbound until the
bindings below exist.

## P1. Operating-characteristic simulation distributions

Problem: the OC stress distributions are fixed only in ignored handoff §8
(R07–R10). The v2 packets cite the confirmatory family but carry no
simulation cases, so draft §5.7's "Fixed in `plans/...`" claim cited an
ignored plan as authority.

Proposed correction: ALDM creates tracked
`protocols/lv01-operating-characteristic.v1.json` carrying, verbatim as
normative fields:

- Component ranges: LV-U `[-2,2]`; LV-P (negative excess-Brier) `[-2,0]`;
  success/probability contrasts `[-1,1]`.
- At null or design-alternative mean mu: Normal working model at SD 0.08
  (declared numerical working model, not a bounded-data claim); endpoint
  Bernoulli on a/b with `P(b) = (mu-a)/(b-a)`; `mu + h*(Z-E[Z])` with
  `h = min(mu-a, b-mu)/2` where Z is `2*Beta(2,2)-1`, `2*Beta(0.5,5)-1`,
  or an equal mixture of `2*Beta(1,8)-1` and `2*Beta(8,1)-1`; and a
  constant mu.
- Dependence: independent component draws plus a shared-quantile
  dependence case; deterministic domain-separated simulation seeds.
- Cells: all-null plus each single-null boundary configuration (others at
  alternatives), at all six candidate Ns `[75,100,125,150,200,300]`,
  30,000 repetitions per cell; simultaneous exact Monte Carlo upper bounds
  at alpha 0.05 divided by the total prespecified cell count.
- Gate: family false-rejection upper bounds ≤ 0.055 (declared 0.005 Monte
  Carlo tolerance, not a new test alpha). Power: inspect the selector under
  each distribution's known dispersion and stated inflation; where it admits
  an N, independently simulate that N and require joint lower power ≥ 0.90
  (unaffordable worst-case distributions need not pass). Zero-variance cases
  must stop sample selection without corrupting unrelated members. Numerical
  computation counts in resources. A falsely admitted or anti-conservative
  stress case blocks registration for a documented methods revision.

Acceptance cases for ALDM:

- A1 (positive): the new file validates under a strict schema (no missing/
  extra fields, no placeholders), is referenced by checksum from the R06
  gate receipt, and an independent re-implementation reproduces the cell
  count and the ≤0.055 gate decision on a pinned seed.
- A2 (negative): deleting any distribution, changing 30,000 repetitions,
  or substituting Normal-only agreement for the full stress set fails
  `check-design` and blocks R06/R08.
- A3 (negative): a zero-variance simulation input stops N selection with a
  named reason while leaving unrelated members' verdicts intact.
- A4 (manuscript sync, after A1): draft §5.7 and review-package M-OC cite
  the new tracked file and digest instead of the handoff.

## P2. Cost benchmark

Problem: the query/verification benchmark lives only in ignored master-plan
§4.5 ("For audit cost ..."). Handoff R06 and the v2 seed policy carry
ceilings and accounting rules but not the benchmark operations, so draft
§5.8 transcribed an unbound method and review-package M-COST cited
`plans/... §7` (which does not even contain the benchmark) as a committed
source.

Proposed correction: ALDM creates tracked
`protocols/lv01-cost-benchmark.v1.json` carrying, verbatim as normative
fields:

- Report whole-cohort actual capture/retention/verification costs on the
  frozen profile.
- Benchmark query and verification operations on the first ten registered
  primary dyads in each confirmatory/replication cohort (canonical stage
  labels per P4), selected independently of outcomes: one warmup and five
  measured invocations per record format, deterministic rotated format
  order; retain individual timings and summarize within dyad before
  across-dyad comparison (five repeats are not five independent study
  units). An invalid selected slot reports its available cost and missing
  operation; never substitute the fastest dyad.
- Mutation challenges on disposable copies: edit, deletion, reordering,
  duplication, wrong-signature, and truncation challenges, plus
  separation-matrix mutation tests injecting peer/target/PRNG data.
  Disclose exactly what trusted final commitment each detector receives.
  Pre-commit omission and semantic dishonesty remain outside cryptographic
  detection. No human-usability benefit is inferred from machine time.

Acceptance cases for ALDM:

- B1 (positive): the new file validates under a strict schema, is
  referenced by checksum from the R06/R09 cost receipts, and a fixture run
  demonstrates warmup+5 ordering, rotated format order, retained individual
  timings, and within-dyad-first summarization.
- B2 (negative): outcome-dependent dyad selection, fastest-dyad
  substitution for an invalid slot, or missing-operation silence fails
  audit with a named error.
- B3 (negative): a mutation challenge run against live (non-disposable)
  evidence is refused before execution.
- B4 (manuscript sync, after B1): draft §5.8 and review-package M-COST cite
  the new tracked file and digest; the `plans/... §7` citation is removed.

## P3. Role table (sender cue / receiver and predictor blindness)

Problem: the v2 packets state a blanket forbidden list including "true
scenario target" (`lv01-study-design.v2.json` `observationSchemas`, and the
same list in `lv01-prototype-execution-profile.v2.json` `runtime`), without
the role split the task requires: the sender MUST receive its approved
private referent cue or the naming game cannot be played, while the receiver
and all action predictors must not receive the true target label. The draft's
§5.3 separation text transcribes the blanket list. Handoff R03-B already
flags this correction as TODO; it is unbound until tracked.

Grounding (tracked implementation, read-only evidence):
`packages/scenario/src/referential-engine.ts` `buildObservationPayloads`
constructs sender rows as attribute codes PLUS a per-candidate 0/1 target
flag (`code === truth.targetTypeCode ? 1 : 0`, plus own utility columns
under negotiation profiles), while receiver rows carry only the permitted
attribute codes (plus own utility columns) with no target column. The
sender's 0/1 flag is therefore the approved private numeric referent cue;
its absence from receiver rows is the implemented blindness. `observation.ts`
(`buildObservation`) is the sole delivery path and assembles the six
Observation fields field-by-field through the hygiene filter.

Proposed correction: ALDM creates tracked
`protocols/lv01-role-access-amendment.v1.json`, amending (not rewriting) the
two v2 files' allow/forbid lists with this normative role table:

| Role | May read | Must not read |
|---|---|---|
| Sender (learner) | Own approved numeric observation tensor INCLUDING the private 0/1 per-candidate referent cue; delivered message tokens; candidate observations in committed order | Peer references/weights/hidden state; scenario seed; action draw/PRNG; wall clock; auditor results; test labels/outcomes |
| Receiver (learner) | Own permitted attribute codes (no target column); own utility columns where the profile provides them; delivered message tokens; candidate observations in committed order | True target label/flag; everything else the sender must not read |
| Action predictors (native, ordinary-record, exact-policy-replay, descriptive) | Their declared information sets at/before the decision turn, with fits restricted to permitted data | Test outcomes; action-PRNG values; post-cutoff ledger events; true test target in ordinary-record fits; future turns |
| Controlled intervention scheduler (NON-learner, declared separately) | True target, solely to select ledger-consistent (target-maximizing, inventory-order ties) and ledger-shuffled (fixed derangement) delivered tokens | Any channel into learner observations or predictors other than the committed delivered-token schedule |
| Post-seal auditor (NON-learner, declared separately) | Raw records, disclosed per-case action draw, parent state, sample outcome — only after sealing | Collector-created true/pass flags as evidence; pre-seal access to outcomes or draws |

Scheduler/auditor boundary rules (normative): the full branch schedule,
delivered-message schedule, and ledger cutoff are committed before labels;
identical-token coincidences are preserved; the scheduler's target knowledge
is a local intervention contrast, never spontaneous partner understanding;
the auditor reconstructs case identity, delivered token,
prediction-before-action ordering, actual draw, parent state, and sample
outcome from raw records only.

Acceptance cases for ALDM:

- C1 (positive): a fixture dyad executes with sender tensors containing the
  0/1 cue column and receiver tensors without it (asserted from built
  Observations, not from config strings); all seven branches run; the
  auditor reconstructs every case from raw records.
- C2 (negative): delivering any forbidden field to a learner role (peer
  state, target label to receiver/predictors, seed, draw, wall clock,
  auditor result) fails loudly at the input boundary; the attempt is
  refused, never silently admitted.
- C3 (negative): a scheduler output used without a pre-label commitment, a
  post-cutoff ledger row in any predictor fit, or an auditor verdict citing
  a collector-created flag fails audit with a named error.
- C4 (manuscript sync, after C1–C3): draft §§3/5.3 and the §5.3-adjacent
  branch/audit text state the role table with the scheduler and auditor as
  separately declared non-learner roles; review-package M-EXEC cites the
  amendment digest.

## P4. Seed labels

Problem: `protocols/lv01-seed-resource-policy.v2.json` contradicts itself:
`derivation.partValues.stages` and `derivation.prohibited` use
`main`/`repeat`, while `stages` keys are `confirmatory`/`replication`;
`pilot.reuseBoundary` ("No pilot/main reuse"), `power.reserveInvalidity`
("per main/repeat stage"), and `replication.rule` ("regardless of main
direction") use the old labels. The same old labels appear in draft §5.6
("Stages: development, qualification, pilot, main, repeat"), the analysis
plan's margin lineage ("preserved through pilot and main"), and the
direction amendment's cohort rule ("no ... main, or repeat cohort"). Handoff
R03 prospectively mandates the canonical labels but, as an ignored plan,
cannot itself fix them.

Proposed correction: ALDM creates tracked
`protocols/lv01-seed-label-amendment.v1.json` declaring the canonical stage
vocabulary `development`, `qualification`, `pilot`, `confirmatory`,
`replication`, with these normative rules:

- All NEW LV01 v2 seed identities use the canonical labels in the `stage`
  part. `main` and `repeat` are rejected as stage parts for new identities
  (validator error, not silent mapping).
- No aliasing: `main`/`repeat` are never mapped to `development` or to each
  other; any retained historical identity bearing them stays reserved and
  collision-checked, never reused.
- Derivation is otherwise unchanged: `deriveSeedHex` SHA-256 over UTF-8
  parts joined by single NUL bytes (`packages/hashing/src/prng.ts`),
  parts root/studyId/stage/policyVersion/slotKind/slotIndex/purpose/role/
  partition/case/branch as applicable; NUL in parts, signing-key
  derivation, and cross-stage or legacy identity reuse remain prohibited;
  scenario/case identities and action draws omit only branch (paired
  branches share scenario, observation, pre-state, draw); intervention
  shuffles and branch orders append branch; learner initialization occurs
  once per dyad.
- Readings: "No pilot/main reuse" reads "no pilot/confirmatory reuse";
  "per main/repeat stage" reads "per confirmatory/replication stage";
  "regardless of main direction" reads "regardless of confirmatory
  direction"; "preserved through pilot and main" reads "preserved through
  pilot and confirmatory"; "no v1 pilot, main, or repeat cohort" reads
  "no v1 pilot, confirmatory, or replication cohort".

Acceptance cases for ALDM:

- D1 (positive): `deriveSeedHex` NUL-join test vectors pass, including a
  vector with canonical `confirmatory` and `replication` stage parts and a
  check that `deriveSeedHex('a','b')` differs from `deriveSeedHex('a\0b')`
  handling (NUL in parts is rejected upstream, never hashed through).
- D2 (negative): materializing any new identity with stage `main` or
  `repeat`, reusing any retained/registered earlier identity (including all
  v1 and E00–E50 identities), or embedding NUL in a part fails validation
  with a named error.
- D3 (negative): a collision check that omits the retained historical
  `main`/`repeat`-labeled identities fails `check-design`.
- D4 (manuscript sync, after D1–D3): draft §5.6 stages line, §5.8 cohort
  wording, and any `main`/`repeat` stage wording read
  confirmatory/replication; review-package M-SEED cites the amendment
  digest. Sibling h1h2 `main`/`repeat` wording in README/run-accounting is
  synced in the same pass.

## ALDM implementation order and HANDYM review

Suggested order: P4 (labels gate every new identity) → P3 (role table gates
R04/R05 acceptance) → P1, P2 (gate R06/R08). HANDYM reviews each tracked
file against its acceptance cases before any manuscript citation is added.
No commits, pushes, or heavy builds are part of this proposal.
