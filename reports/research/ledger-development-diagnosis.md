# LV01 retrospective development diagnosis (R02, draft)

Status: draft — 2026-09-27 UTC. Companion machine-readable record:
`reports/research/ledger-development-analysis-manifest.v1.json`, which carries
every input digest, the per-case rows, and the full eligibility accounting.
Authority: `plans/research-validation-plan.md` (master plan, R02 row) and
`plans/first-publication-implementation-handoff.md` (§3 R02).

This is a **retrospective development diagnosis**, not a study result. It
describes ledger coverage, staleness, and action-prediction scoring on
already-spent sealed development data. It supplies no pilot variance,
confirmatory finding, prior prediction commitment, or next-study effect size,
and it must not be reused inferentially. Do not tune thresholds from it.

## 1. Selected data and dyad counts

Seven sealed recurrent fixtures qualify (88 normal-condition receiver actions
each: 64 running turns + 24 evaluating turns, roles alternating each turn).
Each ran under a distinct execution commit and seed, so each is reported
separately and never pooled into a research N.

| Dyad (runId) | Commit | Hypotheses (A/B) | Eligible cases |
|---|---|---|---|
| lv01-development-v16-p0001 | 8f22f8e | 43 / 51 | 88 |
| lv01-development-v17-p0001 | afc7e38 | 38 / 43 | 88 |
| lv01-development-v18-p0001 | 7ab0b3d | 44 / 52 | 88 |
| lv01-development-v19-p0001 | 0fe683d | 51 / 50 | 88 |
| lv01-development-v20-p0001 | 08015e6 | 56 / 50 | 88 |
| lv01-development-v21-p0001 | 3d654fd | 60 / 43 | 88 |
| lv01-development-v23-p0001 | b9943ce | 58 / 43 | 88 |

Total: 7 dyads, 616 eligible receiver actions. Genuine recurrence was verified
per dyad from the exported policies (gru-actor-critic-v1, 4,049 parameters,
hidden size 16, both roles), not from declared configuration alone.

Accounted and not scored: development v2–v4/v8/v10–v12 (no sealed
receiver-action bundles); v5–v7/v9/v13–v14 (tabular scratch-policy exports —
the same defect class as the v15 erratum — hence not recurrent evidence); v15
(excluded by plan); v22 (preflight failure); paired-development v17–v21
(single-turn branch children of one shared parent case each; intervention
labels unimplemented at those commits); recurrent-lifecycle v1–v4
(state-persistence probes, no behavioral cohort); detector and fault fixtures
(different scope); detector-v3 (sibling-owned, not inspected). The manifest
records each disposition with its reason. R01 lifetime/capacity reconciliation
was still in progress at draft time; no lifetime claim is made here.

## 2. Method (how every number traces)

- **Prefix rule.** For a receiver action at turn `t`, the native predictor
  reads only `hypothesis.*` events on the receiver's own ledger with event
  turn `< t`. Associations are post-outcome records, so the strict inequality
  is what keeps every prediction prospective; same-turn leakage is excluded
  by construction.
- **Native prediction.** Latest preceding association for the delivered
  token, weights over the recorded candidate order plus 1e-12 epsilon,
  normalized (`lv01-ledger-value-prediction/v1` semantics). A delivered
  token with no preceding association scores uniform
  (`uniform-missing-token`). There are no disabled turns in this cohort.
- **Ordinary-record predictors.** Uniform, validation-majority,
  transcript-only, and task-history count models (Laplace +1, matching the
  analysis-package count semantics), each fit on strictly preceding
  same-receiver cases only (expanding window). The 565-coefficient
  ordinary-record-softmax is omitted: it is degenerate on ≤87 preceding
  rows and the committed TypeScript implementation was not executed in this
  docs-only draft.
- **Scoring.** Multiclass Brier loss on the observed receiver action
  position. The recorded live `inferredDistribution` is scored only as a
  descriptive reference — it is the live policy's own output, not frozen
  exact replay, and supports no fidelity claim.
- **Implementation.** Read-only probe over sealed bundles; sealed evidence
  untouched; no new analytics framework. A committed R04/R05 implementation
  must call the learners/analysis packages directly.

Receipt cross-check: all 10 retained-file digests in the v16 recurrent
receipt and all 4 in the v23 receipt recompute exactly, and the v23 bundle
manifest hash matches its offline-verification record.

## 3. Coverage, staleness, and ledger dynamics

| Dyad | Tokens assoc. / 32 | Coverage (all / eval) | Assoc. age mean / max (turns) | Revisions | Argmax flips | Recorded drift mean L2 |
|---|---|---|---|---|---|---|
| v16 | 28 | 0.682 / 0.833 | 24.4 / 69 | 38 | 38 | 0.075 |
| v17 | 27 | 0.693 / 0.958 | 28.7 / 72 | 27 | 27 | 0.116 |
| v18 | 27 | 0.693 / 0.958 | 22.1 / 55 | 42 | 42 | 0.108 |
| v19 | 30 | 0.659 / 0.958 | 22.8 / 64 | 40 | 40 | 0.156 |
| v20 | 29 | 0.670 / 0.917 | 18.7 / 72 | 48 | 48 | 0.079 |
| v21 | 28 | 0.682 / 0.958 | 29.9 / 77 | 47 | 47 | 0.056 |
| v23 | 29 | 0.670 / 0.917 | 24.7 / 73 | 43 | 43 | 0.199 |

Every delivered token is eventually associated (no delivered-never-associated
token in any dyad); misses are early-turn warmup, and eval-phase coverage is
0.83–0.96. Associations are diffuse: mean normalized entropy 2.47–2.74 nats
against 2.77 for uniform over 16 types (mean max weight 0.10–0.21, v23 most
concentrated). Nearly every consecutive same-token update flips the argmax
type, which is expected for noise-dominated near-uniform vectors rather than
evidence of meaningful revision. Unrecorded policy probability drift is
**unavailable** (no frozen replay in this draft); only recorded association
drift is reported. Policy snapshots are retained and digested for future
replay.

## 4. Action-prediction scoring (descriptive, no inference)

Mean Brier loss per dyad (lower is better; uniform = 0.75). `live` is the
live-inference reference described above, not a competitor.

All 88 cases:

| Dyad | native | uniform | majority | transcript | task-history | live | success |
|---|---|---|---|---|---|---|---|
| v16 | 0.7435 | 0.7500 | 0.7737 | 0.7732 | 0.7501 | 0.7197 | 0.352 |
| v17 | 0.7321 | 0.7500 | 0.7842 | 0.8014 | 0.7470 | 0.6766 | 0.205 |
| v18 | 0.7314 | 0.7500 | 0.7683 | 0.7567 | 0.7457 | 0.7244 | 0.284 |
| v19 | 0.7135 | 0.7500 | 0.7843 | 0.7505 | 0.7424 | 0.6351 | 0.182 |
| v20 | 0.7277 | 0.7500 | 0.7835 | 0.7697 | 0.7643 | 0.7058 | 0.205 |
| v21 | 0.7634 | 0.7500 | 0.7738 | 0.7581 | 0.7409 | 0.7382 | 0.239 |
| v23 | 0.6913 | 0.7500 | 0.7859 | 0.7450 | 0.7460 | 0.6506 | 0.216 |

Evaluating phase only (24 cases):

| Dyad | native | uniform | majority | transcript | task-history | live | success |
|---|---|---|---|---|---|---|---|
| v16 | 0.7183 | 0.7500 | 0.7765 | 0.7879 | 0.7438 | 0.6664 | 0.500 |
| v17 | 0.7391 | 0.7500 | 0.7599 | 0.8240 | 0.7232 | 0.6113 | 0.333 |
| v18 | 0.7335 | 0.7500 | 0.7439 | 0.7609 | 0.7471 | 0.7012 | 0.167 |
| v19 | 0.6596 | 0.7500 | 0.7457 | 0.7722 | 0.7242 | 0.5553 | 0.042 |
| v20 | 0.7680 | 0.7500 | 0.7795 | 0.8162 | 0.7952 | 0.7330 | 0.167 |
| v21 | 0.7669 | 0.7500 | 0.7368 | 0.7641 | 0.7205 | 0.7441 | 0.125 |
| v23 | 0.5815 | 0.7500 | 0.8072 | 0.7572 | 0.7370 | 0.5157 | 0.125 |

On covered eval cases only (20–23 per dyad), native Brier is
v16 0.7119, v17 0.7386, v18 0.7328, v19 0.6557, v20 0.7696, v21 0.7676,
v23 0.5662, against uniform 0.75 — small and inconsistent directional
differences across seven unpooled dyads. The ledger tracks the policy's
own (often incorrect) behavior rather than the task: live inference is
sharper than uniform in every dyad while eval task success is 0.04–0.50.
Small-window count comparators frequently score worse than uniform, as
expected for Laplace-smoothed fits on ≤44 preceding rows. None of this is
a significance claim; with one dyad per configuration there is no basis
for one.

## 5. Exposures and what remains unknown

- Observed: 7 recurrent dyads × 88 normal-condition turns, 616 scored
  receiver actions, 682 hypothesis associations, full per-case trace in
  the manifest. Instrumentation is intact (one interpretation per turn on
  the receiver ledger, valid 16-weight associations, sealed chains,
  verifier exit 0); stored live distributions are rounded to 6 decimals.
- Unobserved here: any control/intervention contrast (all turns are
  normal condition), exact-replay fidelity, unrecorded drift, pilot or
  main cohorts, and the detector-v3 outcome.
- The development ledgers are diffuse near-uniform summaries of poorly
  learned policies — consistent with "failure to learn within budget is
  a valid observation", not with a pilot-ready effect.

## 6. Input digests (primary files; full set in the manifest)

| Dyad | baby-a-ledger.jsonl | baby-b-ledger.jsonl | turn-records.jsonl | run-config.json |
|---|---|---|---|---|
| v16 | 7498863b…9b178d | beb1ad75…0f54cc | efbb0a10…df4e4f | 257a2353…400ff4 |
| v17 | 1ef8d3d7…e9742c | bf548da6…5081ad | 1161a921…361bbd | 1c40ec6f…43438f |
| v18 | 2a53fd6e…b80c95 | becfae0b…595fba | 5cdde115…499c54 | d70b830f…5902c7 |
| v19 | c3705371…33ef82 | 8b91949b…dd4ed7 | b3ff1cb8…e61265 | c0d655e1…333640 |
| v20 | 5eccc1aa…ccd558 | 710f5676…d62019 | 3f14c4ff…80528d | 511364bb…c8acd2 |
| v21 | 2c03efdc…9f7fee | 60278c06…0e3a3a | b8cf788f…efc4e7 | d1caa814…f2b9a4 |
| v23 | 3cd85fe4…a0af51 | cf028c53…f2a12d | 07c62f9b…686ec1 | b4e23fce…5b26da |

(All `sha256:`-prefixed full digests, plus channel transcripts,
fixture/verification records, run configs, and all four policy snapshots
per dyad, are recorded under `dyads.<runId>.inputDigests` in the manifest.)

## 7. Limitations and claim boundary

- Descriptive only; no inferential reuse, no threshold tuning.
- One dyad per configuration; no pooling; v20/v21 native scores slightly
  worse than uniform on eval cases.
- Softmax ordinary comparator omitted (see §2); unrecorded drift and
  exact replay unavailable in this draft.
- R01 inventory pending; detector-v3 not inspected; lifetime-iteration and
  resource-balance claims are out of scope here.

Claim boundary: this diagnosis supports only bounded retrospective
observations about retained development ledger coverage, staleness, and
action-prediction scoring. It establishes no semantic-ledger utility,
fidelity, cost, language-emergence, calibration, pilot, or scientific
result.
