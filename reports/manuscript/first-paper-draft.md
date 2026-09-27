# First paper draft — private ledger records for action prediction (skeleton)

Status: **pre-results skeleton**. Every `TBD` marks a field that must be
populated only from verified R09/R10 evidence. No result stated here is an
observation. Venue target (conditional): TMLR; see
`plans/publication-venue-assessment.md` and `review-package.md` for the
preparation gate and current author-guide rules.

## 1. Exact question

In a trusted Prototype runtime running a fixed recurrent-learner naming game,
do private policy-derived semantic summaries (ledger records):

1. improve pre-action prediction beyond ordinary interaction records (utility),
2. approximate the underlying policy faithfully rather than trivially (fidelity),
3. causally affect task behavior when delivered as messages (causal use), and
4. at what measured capture, storage, query, and verification cost (audit cost)?

Positive answers to (1)–(3) are independent claims. A fidelity pass alone is
insufficient for a useful-ledger claim: summary–policy agreement without
incremental predictive value, causal effect, or acceptable cost does not
support the paper's thesis.

## 2. Study population

- Unit of analysis: the dyad (one sender–receiver pair through one complete
  LV01 v2 run). Both-role observations remain within their dyad; analysis is
  at dyad level with dyad-level uncertainty.
- Population: `TBD` main-stage dyads at the locked sample size N=`TBD`,
  drawn from the registered seed domain `TBD`, plus `TBD` fresh-seed repeat
  dyads at the same N (R10). Pilot dyads (20, R07) select N and are not
  confirmatory observations.
- Inclusion: only runs admitted by the R05 provenance/admission contracts
  with complete manifests, verified evidence, and retained charges. Excluded,
  invalid, aborted, and reserve runs are accounted in `run-accounting.md`;
  exclusion rules were frozen before main labels (R08) and are stated in §5.
- The study does not sample human language, open-ended dialogue, or
  adversarial deployments. Generalization beyond the stated game, learner
  family, and channel is explicitly disclaimed (§8, external validity).

## 3. Information-access table and mode limitations

Each comparator row lists exactly what the predictor may read before the
action is committed. No comparator reads future actions, probe labels held
out from training, or fields the causal-ledger protocol forbids.

| Comparator | Reads before action | Must not read |
|---|---|---|
| Ordinary records only | `TBD` (allowed ordinary-record fields from the R03 packet) | Ledger content, snapshots, future turns |
| Latest permitted sparse ledger | Ordinary records + latest ledger snapshot at/before the decision turn | Future ledger revisions, probe labels |
| One-checkpoint-stale ledger | Ordinary records + previous-checkpoint ledger | Current-checkpoint ledger, future turns |
| Equal-content unsigned history | Ordinary records + unsigned record with byte-identical semantic content | Signature/anchor fields (tests content, not signing) |
| Periodic full association snapshot | Ordinary records + full snapshot at 64-episode cadence plus cutoffs | Off-cadence state |

Mode limitations: this is a trusted-Prototype study, not an adversarial
process-isolation study. Physical isolation and timing-channel claims do not
transfer from the separate Mode R qualifications. Logical isolation rests on
the stated field allow/block lists, enforced by the collector and checked by
negative cases (delivery of forbidden fields must fail loudly); it is not a
hardware or side-channel guarantee. See §8 (logical isolation) and the
 skeptical-review record in `review-package.md`.

## 4. Inherited foundation versus new work

| Element | Inherited (provenance) | New in this study |
|---|---|---|
| Prototype runtime, recurrent learner family, naming game, fixed-token channel | Tracked source at `TBD` commit; qualification receipts `TBD` | No redesign; frozen via R03 packet |
| Ledger capture, signing, verification machinery | Prior qualification receipts `TBD` | None claimed |
| LV01 v2 design/analysis/resource/profile amendment (D01–D12) | — | R03 packets `TBD` |
| Prediction/intervention/replay integration (delivered messages, pre-action vectors, true draws, state resets) | — | R04, verified by negative/positive cases `TBD` |
| Study CLI, provenance, admission, terminal accounting | — | R05 command contracts `TBD` |
| Main + repeat data, fixed analysis, reproduction | — | R09/R10 evidence `TBD` |
| Manuscript, estimates, accounting, artifact, review package | Prior pre-results drafts and audits (see `reports/research/research-critical-review.md`, `reports/research/manuscript-readiness-audit.json`) as process precedent, not inherited results | This package |

No inherited bundle supplies an empirical estimate. The frozen
data/claim inventory (`docs/data-and-claim-inventory.md`) records zero
research-included bundles at cutoff; any future inclusion needs an explicit
decision, never mere presence or a verifier pass.

## 5. Methods

Methods below are design facts transcribed strictly from the frozen LV01 v2
packets (R03, commit `9be6e536`) and other committed planning sources. No
value here is a measurement. Every empirical field stays `TBD` until
R09/R10. Packet governs on any conflict with this prose.

### 5.1 Design, registration, and analysis plan

| Packet | Path | SHA-256 |
|---|---|---|
| Study design | `protocols/lv01-study-design.v2.json` | `sha256:8fa62f2d8b32f2dfadf0db6450e4687dd9bb85e93824afbb4827edb345cb4743` |
| Analysis plan | `protocols/lv01-analysis-plan.v2.json` | `sha256:87be303e23b5dee518ef7c9742701475556b33ed8cef91dd18863eb2965c8df2` |
| Seed/resource policy | `protocols/lv01-seed-resource-policy.v2.json` | `sha256:2c3c483c7b44c3072fa72c2c9f285c14062db75d7ff2d135288ac477edb84d07` |
| Execution profile | `protocols/lv01-prototype-execution-profile.v2.json` | `sha256:3880e72bc37ddb6cb94094399bf22dcec327777fb387158e4488590292653c86` |
| Direction amendment | `protocols/lv01-direction-amendment.v2.json` | `sha256:8d661ca1b7ef719f27843d86d0d08dc3009817a440d978678772525b2fea3cd9` |

Status honestly stated: the packets self-declare
`draft-not-registered-not-executed` (seed policy:
`draft-outcome-blind-no-stage-allocation`). They are the frozen design
record, not a registration, allocation, qualification, pilot, result,
replication, review, or publication, and they authorize no run. LV01 v1
files are preserved byte-for-byte; no v1 pilot, main, or repeat cohort
exists, and development records must not be relabeled as stage evidence.
The five-iteration lifetime allowance is not renewed by the amendment.
Registration, qualification (R06), pilot (R07), and lock (R08) receipts:
`TBD`.

### 5.2 Task, learner, and channel

- Task: `referential-game-v1`, 2 attributes × 4 values, type-code rule
  `4 * firstAttribute + secondAttribute`, 4 candidates per episode, chance
  success 0.25. Eligible type codes
  `[1,2,3,4,6,7,8,9,11,12,13,14]`; untouched diagonal `[0,5,10,15]`.
- Partitions: training 3,000 cases (1,500 per receiver role, 125 per
  eligible target per role, policy updates on); validation-fit 240,
  validation-selection 240, within-support test 240 (each 120 per role, 10
  per eligible target per role, no policy updates). Canonical scenario
  content and IDs are distinct across partitions after outcome-free
  rederivation; deliberate seven-branch reuse inside one test case is
  required. Split names `held-out` and `evaluation` are prohibited. Fresh
  within-support cases are not new-type generalization or compositionality
  evidence.
- Learner: scratch-RL track, `gru-actor-critic-v1`, 2 agents with
  independent training isolation. Input 50, hidden 16, sender output 32,
  receiver output 16, value output 1; 4,049 parameters per agent.
  Extrinsic-task learning signal; Adam (`lr=0.003`, `beta1=0.9`,
  `beta2=0.999`, `eps=1e-8`); PPO clip 0.2, 4 epochs, value-loss
  coefficient 0.5, max gradient norm 1.0; temperature 1; role-reversal
  period 1; no learning during validation or test. Forbidden: cross-agent
  updates, auxiliary reward, architecture search, curriculum, repair,
  affect, negotiation, and policy updates during validation or test.
- Channel: fixed-token carrier, inventory 32, 1 mark per message, maximum
  capacity 5 bits. Maximum carrier capacity is not measured information
  or syntax.

### 5.3 Execution profile and integrity

- Deployment: Prototype mode, `prototype-disposable-worker` topology, one
  dyad per disposable worker with deterministic step ordering, at most one
  parallel dyad. Simulated anchor class; no artificial release padding;
  normal termination and resource guards retained; existing Mode R
  deadline/safety code unchanged and unclaimed.
- Separation: separate agent state, weights, optimizers, memories, PRNG
  domains, and ledger handles. Allowed inputs: approved numeric
  observation tensors, delivered message tokens, candidate observations in
  committed order. Everything else is forbidden (peer references/weights/
  hidden state, true scenario target, scenario seed, action draw/PRNG,
  wall clock, auditor results, test labels/outcomes). This is logical
  separation under a trusted process and operator for cooperative
  learners, established by code-path and input-boundary checks — not
  resistance to a malicious shared-process agent, and no side-channel
  claim.
- Records: local append-only event records with authenticated prefixes
  and checkpoint identities; simulated commitments with both existing
  verifier implementations where applicable; originals and failure
  records kept; virtual step indices for scientific ordering with
  separate monotonic cost measurements.
- Retention: full model/optimizer/hidden-state snapshots at
  initialization, every 64 training episodes, the final training cutoff,
  and all required scientific boundaries; every event, observation,
  action, update identity, and post-update digest. No full model blob per
  turn or per branch directory; a digest-only update record is a
  commitment, not a snapshot-attachment claim. Deterministic replay from
  each retained checkpoint through its next block must reproduce all
  update digests, else the retention format is unqualified.
- Batch evaluation: train once, then batch frozen evaluation in the same
  worker, restoring identical final policy and recurrent checkpoint
  state before every case and branch. No per-action evidence copies or
  service boots; immutable parent digests with child references; parent
  blobs exported once per dyad.
- Pre-action commitment: before the first test receiver action, commit
  ordered case/candidate identities, full probability vectors for native,
  ordinary-record, and replay predictors, predictor versions and fitted
  digests, the delivered-message schedule, ledger cutoff, policy/state
  digests, and action-draw commitments. Persist the canonical payloads;
  hashing inputs alone is insufficient. Test outcomes and action-PRNG
  values are inaccessible to predictors at commitment time.
- Action draw: one privately derived uniform draw per case, shared
  across branches, disclosed to the auditor after sealing; fixed
  candidate order with inverse-CDF sampling. The draw never enters any
  learner observation or prediction function. Verification covers both
  seed derivation and the actual resulting action.
- Branches (7): normal, disabled, constant (inventory element 0), random
  (dedicated uniform stream), shuffled (role-local derangement),
  ledger-consistent (token maximizing the native predictor's target
  probability, inventory-order ties), ledger-shuffled (fixed-derangement
  permutation of those messages within role). Identical-token
  coincidences preserved. The experimenter knows the target for this
  controlled intervention; receiver and baselines do not — a local
  intervention contrast, not spontaneous partner understanding. Branch
  order is a deterministic seeded permutation per case, counterbalanced;
  scenario, receiver observation, pre-state, and draw are shared across
  branches within a case. Yield: 5,160 receiver decisions per dyad (1,680
  test).
- Audit: an independent auditor reconstructs case identity, delivered
  token, prediction-before-action ordering, actual draw, parent state,
  and sample outcome from raw records. Collector-created true flags and
  pass flags are forbidden as audit evidence. All schedules committed
  before labels.

### 5.4 Predictors and information access

Prediction target: the receiver's actual selected candidate position
(task target and task success are separate fields; target-action
probability is used only for LV-L).

| Predictor | Role | Fit |
|---|---|---|
| `uniform` | Descriptive reference | Candidate count |
| `validation-majority` | Ordinary-record | Laplace-smoothed actual action positions; declared folds, final refit on all permitted training + validation |
| `transcript-only` | Ordinary-record | Laplace-smoothed actual action positions conditional on delivered token only |
| `task-history` | Ordinary-record | Laplace-smoothed token/type counts from ordinary records |
| `ordinary-record-softmax` | Ordinary-record | Bias + token/candidate/position one-hots + token/type interaction (565 coefficients); 2,000 full-batch steps, lr 0.05, L2 0.01 excluding bias, zero init |
| `native-ledger` | Primary under test | Latest authenticated receiver token association strictly before the training cutoff (`hypothesis.created/revised/contradicted` events; `associationOverTypeCodes` normalized over current candidates after +1e-12 per weight; missing token → uniform + reported coverage) |
| `exact-policy-replay` | Mandatory primary reference | Frozen recurrent receiver forward pass with checkpoint hidden state, delivered token, candidate observation, temperature 1; no state advance |
| `equal-content-unsigned-log` | Descriptive information match | Byte-identical numerical payload and update schedule as native; predictions must match exactly |
| `fixed-cadence-policy-summary` | Descriptive richer record | Same 32×16 association representation at fixed training checkpoints every 64 episodes and the final cutoff, same frozen projection for both roles; actual bytes/queries reported |
| `outcome-reading-oracle` | Diagnostic only | One-hot actual action after outcome; never a predictive competitor |

Ordinary-record window: training 1,500 cases per receiver role,
validation-fit 120, validation-selection 120. Selection: lowest realized
multiclass Brier on validation-selection (tie tolerance 1e-12, then
predictor list order). The chosen model refits on training +
validation-fit + validation-selection before test prediction. Forbidden
in ordinary fits: ledger events, policy bytes, hidden state, action
PRNG, future test data, true test target. All candidates published, not
only the selected comparator. Score: multiclass Brier
`sum((q - one_hot(action))^2)`; LV-P uses expected excess replay Brier
`sum((native - replay)^2)`.

### 5.5 Primary family, margins, and inference

Four-member family (LV-U, LV-P, LV-C, LV-L), seven components,
family-wise alpha 0.05:

| Member | Component | Statistic (dyad mean) | Null boundary | Design alternative |
|---|---|---|---|---|
| LV-U | incremental | Normal-branch ordinary-selected Brier minus native Brier | ≤ 0.02 | 0.04 |
| LV-P | fidelity | Negative mean normal-case expected excess replay Brier | ≤ −0.02 | −0.01 |
| LV-C | disabled | Normal success minus disabled success | ≤ 0.05 | 0.10 |
| LV-C | constant | Normal success minus constant success | ≤ 0.05 | 0.10 |
| LV-C | random | Normal success minus random success | ≤ 0.05 | 0.10 |
| LV-C | shuffled | Normal success minus shuffled success | ≤ 0.05 | 0.10 |
| LV-L | intervention | Exact-replay target-action probability, ledger-consistent minus ledger-shuffled | ≤ 0.05 | 0.10 |

LV-U inherits the outcome-blind H4 margin 0.02 and planning alternative
0.04 from `protocols/confirmatory-practical-margins.v1.json` and
`protocols/confirmatory-power-model-amendment.v1.json` — prospective
relevance conventions, not measured human-utility thresholds, preserved
through pilot and main. Component ranges: LV-U [−2,2], LV-P [−2,0],
success/probability contrasts [−1,1].

- Unit: independently trained dyad; average within receiver role, then
  equally across roles, then across dyads. Both-role observations stay
  within their dyad.
- Test: one-sided seed-level Student t of mean statistic greater than
  boundary. LV-C member p-value is its maximum component p-value; Holm
  adjusts LV-U, LV-P, LV-C, LV-L in that order for exact ties.
- Zero-SD rule: return p=1 with flagged degenerate interval; never
  divide by zero. A degenerate component must not make unrelated
  members inconclusive.
- Intervals: marginal two-sided 95% seed-level t intervals plus
  simultaneous one-sided component bounds at alpha 0.05/7.
- Sensitivity: 10,000-resample deterministic dyad bootstrap is
  descriptive only; never select the more favorable test. Invalidity
  sensitivity reports valid-only inference plus descriptive
  worst-admissible-value bounds across every attempted dyad; missingness
  is not claimed ignorable.
- Interpretation: a positive **useful-ledger-prediction** claim requires
  both LV-U and LV-C support plus a native predictor that beats uniform
  in reported held-out scoring. LV-P supports fidelity within 0.02
  expected excess Brier only — never additional information beyond
  complete policy state — and LV-P alone cannot license a useful-ledger
  sentence. LV-L supports a controlled local intervention contrast,
  not introspection, composition, or spontaneous partner understanding.
  Non-rejection is reported as not supported at the registered
  threshold; equivalence or no effect is never asserted. Equal-content
  and compact-summary comparisons stay descriptive with intervals; they
  do not acquire confirmatory status afterward.
- Invalidity: frozen technical rules only (wrong source/configuration,
  partition contamination, missing required evidence, broken
  chronology/restoration, execution abort). Low success, high loss,
  slow convergence, and inconvenient estimates remain valid.
  Replacement consumes only ordered registered reserves; a depleted
  reserve pool closes the stage incomplete.

### 5.6 Seeds, stages, and sample-size selection

- Seed root: `ald-ledger-value-v2`. Every materialized seed is the
  SHA-256 hex of UTF-8 parts joined by single NUL bytes, with parts
  root/studyId/stage/policyVersion/slotKind/slotIndex/purpose/role/
  partition/case/branch as applicable. Stages: development,
  qualification, pilot, main, repeat. Purposes include
  scenario/learner-per-agent/gateway/action-draw/intervention-shuffle/
  branch-order/analysis. Scenario/case identities and action draws omit
  only branch (paired branches share scenario, observation, pre-state,
  draw); intervention shuffles and branch orders append branch; learner
  initialization occurs once per dyad. All identities are unique across
  LV01 v2 and collision-checked against every retained and registered
  earlier identity including all v1 and E00–E50 identities. NUL in
  parts, signing-key derivation, and any cross-stage or legacy identity
  reuse are prohibited.
- Development: lifetime 5-iteration allowance (not renewed); small
  fixture (64 training cases, 24 cases per evaluation partition, 0.25
  CPU-hours, 1 GiB); five complete full-workload calibration dyads for
  software measurement only.
- Qualification: 25 fresh qualification seeds (separate from the 20
  pilot dyads; no research-seed consumption), six no-learning/oracle
  conditions with 200 evaluation cases each on the v2 generator.
- Pilot: 20 primary dyads, 0 reserves, all-valid required, no
  pilot/main reuse. Pilot output for selection exposes centered
  dispersion, validity, and costs only; pilot effect means cannot change
  design alternatives. An invalid or incomplete pilot cohort stops
  design lock — no silent extra runs or complete-case substitution.
- Confirmatory candidates: N in `[75,100,125,150,200,300]` (six
  values). Selector: smallest candidate whose seven-component
  union-bound lower power is at least 0.90 and whose complete allocation
  fits the existing resource envelope; if that N cannot be funded, no
  smaller underpowered N is selected. Selector arithmetic: upper
  dispersion `s * sqrt(19 / qchisq(0.05/7, 19))`, component screening
  alpha 0.0125 (0.05/4), 30,000 Monte Carlo repetitions per candidate
  per component, per-component lower bound `qbeta(0.05/42, k,
  30000-k+1)` (`0` if `k=0`), family lower bound
  `max(0, 1 - sum(1 - component_lower))`. Zero or nonfinite dispersion
  blocks selection. Locked N=`TBD` (R08 not run).
- Reserves: one-sided 95% Wilson upper invalid-run probability from
  the pilot; smallest R with `P[Binomial(N+R,pUpper) <= R] >= 0.95`,
  separately per main/repeat stage. The complete `2*(N+R)` allocation
  plus overhead and a fixed analysis/reproduction/packaging allocation
  must be reserved before main starts. R=`TBD`.
- Repeat: fresh stage identities, same locked N and ordered reserve
  rule as confirmatory, no outcome-based retuning; the fresh-seed
  repeat executes regardless of main direction.

### 5.7 Operating-characteristic validation of the selector

Fixed in `plans/first-publication-implementation-handoff.md` §8 (the
v2 packets cite the family; the handoff fixes the simulation cases).
At null or design-alternative mean mu, test: a Normal working model at
SD 0.08 (numerical working model, not a bounded-data claim); endpoint
Bernoulli on a/b with `P(b) = (mu-a)/(b-a)`; `mu + h*(Z-E[Z])` with
`h = min(mu-a, b-mu)/2` where Z is `2*Beta(2,2)-1`,
`2*Beta(0.5,5)-1`, or an equal mixture of `2*Beta(1,8)-1` and
`2*Beta(8,1)-1`; and a constant mu. Test independent component draws
and a shared-quantile dependence case with deterministic
domain-separated simulation seeds. Check all-null and each single-null
boundary configuration (others at alternatives) at all six candidate
Ns, 30,000 repetitions per cell, with simultaneous exact Monte Carlo
upper bounds at alpha 0.05 divided by the total prespecified cell
count. Gate: family false-rejection upper bounds ≤ 0.055 (a declared
0.005 Monte Carlo tolerance, not a new test alpha). For power, inspect
the selector under each distribution's known dispersion and stated
inflation; where it admits an N, independently simulate that N and
require joint lower power ≥ 0.90 (unaffordable worst-case
distributions need not pass). Zero-variance cases must stop sample
selection without corrupting unrelated members. Numerical computation
counts in resources. A falsely admitted or anti-conservative stress
case blocks registration for a documented methods revision. Receipt:
`TBD` (R06/R08 not run).

### 5.8 Cost measurement and mutation challenges

- Report whole-cohort actual capture/retention/verification costs on
  the frozen profile. Benchmark query and verification operations on
  the first ten registered primary dyads in each main/repeat cohort,
  independently of outcomes: one warmup and five measured invocations
  per record format, deterministic rotated format order; retain
  individual timings and summarize within dyad before across-dyad
  comparison (five repeats are not five independent study units). An
  invalid selected slot reports its available cost and missing
  operation; never substitute the fastest dyad.
- Mutation challenges run on disposable copies: edit, deletion,
  reordering, duplication, wrong-signature, and truncation challenges,
  plus R06 separation-matrix mutation tests injecting peer/target/PRNG
  data. Disclose exactly what trusted final commitment each detector
  receives. Pre-commit omission and semantic dishonesty remain outside
  cryptographic detection. No human-usability benefit is inferred from
  machine time. Mutation detection and false-acceptance rates and the
  coverage table: `TBD` (`estimates-and-intervals.md` T6; R06/R09 not
  run).
- Global ceilings (include prior work; not unused allowances): 72
  CPU-hours, 25 GiB retained plus working storage, 6 GiB resident
  memory, zero external spending. Count failures, retries,
  verifier/reproduction costs, temporary duplication, and final
  retention; raw and export bytes counted once each with deduplicated
  blobs explicit. After five complete full-workload calibration dyads,
  reserve twice the largest complete per-slot CPU/storage/wall cost
  and 1.5× the conservative peak-memory bound; reconcile maxima again
  after pilot. Missing historical CPU is charged by an existing
  defensible upper allocation; absent any bound, capacity stays
  unresolved. Wall time is tracked separately from CPU. If
  reconciliation shows the lifetime allowance exhausted, record the
  deviation with the exact additional bounded allowance required and
  stop new collection until a prospective authorization exists. All
  measured costs: `TBD` (T7; R06–R10 not run).

## 6. Results (shells — populate only after R09/R10)

Result tables live in `estimates-and-intervals.md`; this section states the
reading order and the claims each table can and cannot support.

1. Training curves and causal controls: learning actually occurred and the
   intervention machinery moved behavior. Without this, downstream contrasts
   are uninterpretable.
2. LV-U (incremental utility): pre-action Brier contrast of ledger-assisted
   versus ordinary-record prediction, with dyad-level interval, at locked N.
   Nulls and failures reported alongside any positive.
3. LV-P (predictive equality): equal-content signed-versus-unsigned
   comparison. A difference here implicates the signature channel, not
   content; the paper makes no signing-improves-semantics claim either way.
4. LV-C (causal use): message-ablation/substitution probe effects on task
   behavior. Task success alone is never read as causal listening.
5. LV-L (`TBD` definition from the R03 packet): `TBD`.
6. All baselines: every registered comparator reported, including ones that
   beat the ledger. No outcome selection.
7. Cost table: measured capture, storage, query, and verification cost with
   the same completeness standard as the effect tables.
8. Repeat (R10): fresh-seed same-N results beside main results, with honest
   independence status (same team/codebase, new seeds; not an independent
   replication — see `review-package.md`).

Current content: `TBD` throughout. The study may finish with no supported
improvement; that outcome produces a correct report about what was learned,
not a failed paper.

## 7. Limitations

- Trusted setting only: no adversarial, timing-channel, or hardware-isolation
  conclusions (§3).
- One learner family, one game, one channel: no compositional-generalization
  or acquisition claim. Chronological meaning development (LV02) and factored
  grounding (LG01) are separately planned core studies, not results here.
- Seed uncertainty: inference is conditional on the registered seed domain;
  the fresh-seed repeat probes but does not eliminate seed dependence.
- Cost figures are measurements on the frozen profile, not universal prices;
  resource ceilings and the iteration allowance are stated in
  `run-accounting.md`.
- Review status: internal skeptical review only unless a critical human
  reading is obtained; automated review is never labeled independent human
  review.

## 8. Skeptical-review responses (shell)

Each item must be answered with evidence citations at manuscript freeze; the
working checklist and verdicts live in `review-package.md`.

1. Trivial fidelity: `TBD` — show the ledger is not a restatement of inputs
   the predictor already had (stale-ledger and equal-content controls).
2. Weak comparators: `TBD` — justify each baseline as the strongest fair
   representative of its information set.
3. Temporal leakage: `TBD` — cite the chronology checks and negative cases
   proving no future-information access.
4. Outcome selection: `TBD` — all registered outcomes reported; analysis ran
   once on sealed data.
5. Logical isolation: `TBD` — field allow/block enforcement evidence; no
   broader isolation claim.
6. Seed uncertainty: `TBD` — fresh-seed repeat agreement/disagreement stated
   plainly.
7. Cost: `TBD` — full measured cost beside every effect; no cost-free framing.
8. External validity: `TBD` — explicit non-claims (no acquisition,
   composition, adversarial, or human-language generalization).

## Declarations (shell)

- AI assistance: `TBD` — disclose AI-assisted development and drafting; human
  authors take responsibility for all content.
- Contributions, funding, conflicts, licenses, data/model release
  restrictions: `TBD` — complete at release review before any submission.
- Submission material under current TMLR guidance is CC BY 4.0; release
  review must cover licensing and disclosure before upload.
