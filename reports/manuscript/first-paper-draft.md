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

Design, registration, and analysis plan: `TBD` (R03 packets, protocol hashes).
Summary of locked choices (to be verified against the sealed packets at
manuscript freeze):

- Learner: one recurrent family, `TBD` hyperparameters. Game: one numeric
  naming game, `TBD` configuration. Channel: fixed-token, `TBD` inventory.
- Primary family: seven components under the R08 selector; incremental
  ordinary-record utility uses the prior H4 0.02 Brier margin and 0.04
  planning alternative. Candidate Ns: `TBD` (six values); locked N=`TBD`.
- Multiple-comparison policy: `TBD` exactly as registered (Holm-Bonferroni
  across primary metrics per the checklist mapping, unless the packet states
  otherwise — packet governs).
- Uncertainty: dyad-level intervals from the fixed analysis; method `TBD`.
- Operating-characteristic validation of the selector (Normal working model
  SD 0.08, endpoint, scaled-Beta/mixture, and constant cases; independent and
  shared-quantile draws; 30,000 repetitions per cell; family false-rejection
  upper bounds ≤ 0.055): receipt `TBD`.
- Cost measurement: actual capture/storage/query/verification cost on the
  frozen profile; method and receipt `TBD`. Numerical computation counts in
  resources; wall time tracked separately from CPU.
- Mutation testing: mutation detection and false-acceptance rates for the
  evidence pipeline; coverage table `TBD` (`estimates-and-intervals.md`).

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
