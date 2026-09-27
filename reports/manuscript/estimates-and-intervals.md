# Estimates and intervals (skeleton)

Status: **shells only**. Every cell below is `TBD` until generated from sealed
R09/R10 evidence by the stated generator. No number here is an observation.

## Generation contracts

| Table | Generator (command) | Inputs (sealed evidence) | Output receipt |
|---|---|---|---|
| T1 training curves | `TBD` (R05/R09 analysis command) | `TBD` stage evidence path + manifest digest | `TBD` |
| T2 causal controls | `TBD` | `TBD` | `TBD` |
| T3 LV-U/P/C/L estimates + intervals | `TBD` fixed-analysis command, run once on sealed data | `TBD` | `TBD` |
| T4 baselines (all comparators) | same run as T3 (no re-analysis) | same as T3 | same as T3 |
| T5 equal-content predictive equality | same run as T3 | same as T3 | same as T3 |
| T6 mutation detection / false acceptance | `TBD` mutation-coverage command | `TBD` | `TBD` |
| T7 cost (capture/storage/query/verification) | `TBD` cost-accounting command | `TBD` | `TBD` |
| T8 repeat (fresh-seed, same N) | same commands, repeat allocation | `TBD` repeat evidence path + digest | `TBD` |

Rules: T3–T5 come from a single fixed-analysis run on sealed main data — one
run, not one run per table. T8 reruns the identical commands on repeat data;
never tune the repeat from main outcomes. Figures are generated artifacts
checked into this directory beside the tables; no hand-drawn or hand-edited
numbers appear in any figure.

## Component definitions (verify against the sealed R03 packet at freeze)

- LV-U: incremental utility, range [-2, 2]. Primary contrast uses the prior
  H4 0.02 Brier margin and 0.04 planning alternative.
- LV-P: negative excess-Brier predictive-equality component, range [-2, 0].
- Success/probability contrasts, range [-1, 1].
- LV-L: `TBD` — definition, range, and role exactly as registered.
- LV-C: causal-use probe effects; task success alone is never read as causal
  listening.
- Uncertainty: dyad-level intervals; method `TBD` exactly as registered.

## T1. Training curves — shell

| Dyad-set | Episodes | Metric | Final value | Curve figure |
|---|---|---|---|---|
| Main (N=`TBD`) | `TBD` | `TBD` | TBD | `TBD` |
| Repeat (N=`TBD`) | `TBD` | `TBD` | TBD | `TBD` |

Learning-control gate: if training curves show no learning, downstream
contrasts are reported as uninterpretable, not as nulls.

## T2. Causal controls — shell

| Probe | Manipulation | Effect on task behavior | Interval | Interpretation |
|---|---|---|---|---|
| Message ablation | `TBD` | TBD | TBD | TBD |
| Message substitution | `TBD` | TBD | TBD | TBD |
| Detector-positive control | `TBD` | TBD | TBD | TBD |

## T3. LV-U/P/C/L estimates and intervals — shell

Locked N=`TBD`. All components reported, including nulls and failures.

| Component | Estimate | Interval (level `TBD`) | Practical margin | Pre-registered decision |
|---|---|---|---|---|
| LV-U | TBD | TBD | 0.02 Brier | TBD |
| LV-P | TBD | TBD | `TBD` | TBD |
| LV-C | TBD | TBD | `TBD` | TBD |
| LV-L | TBD | TBD | `TBD` | TBD |
| Success/probability contrasts | TBD | TBD | `TBD` | TBD |

Multiple-comparison policy: `TBD` exactly as registered.

## T4. All baselines — shell

| Comparator | Information set | Metric | Estimate | Interval |
|---|---|---|---|---|
| Ordinary records only | `TBD` allowed fields | TBD | TBD | TBD |
| Stale ledger | previous checkpoint | TBD | TBD | TBD |
| Equal-content unsigned | byte-identical content, no signature | TBD | TBD | TBD |
| Full snapshot | 64-episode cadence + cutoffs | TBD | TBD | TBD |

Every registered comparator appears, including any that beat the ledger.

## T5. Equal-content predictive equality — shell

| Comparison | Metric | Estimate | Interval |
|---|---|---|---|
| Signed vs unsigned, identical content | `TBD` | TBD | TBD |

Reading rule: a difference implicates the signature channel, not semantic
content. The paper makes no signing-improves-semantics claim in either
direction.

## T6. Mutation detection / false acceptance — shell

| Mutant class | Injected | Detected | False acceptances | Coverage note |
|---|---|---|---|---|
| `TBD` | TBD | TBD | TBD | TBD |

## T7. Cost — shell

Measured on the frozen profile; wall time separate from CPU; numerical
computation counted in resources.

| Stage | Capture | Storage | Query | Verification | Wall time | CPU |
|---|---|---|---|---|---|---|
| Pilot (20 dyads) | TBD | TBD | TBD | TBD | TBD | TBD |
| Main (N=`TBD`) | TBD | TBD | TBD | TBD | TBD | TBD |
| Repeat (N=`TBD`) | TBD | TBD | TBD | TBD | TBD | TBD |
| Analysis + reproduction + packaging | TBD | TBD | TBD | TBD | TBD | TBD |

## T8. Repeat — shell

Same N, fresh seeds, unchanged commands. Report agreement/disagreement
plainly, including negative outcomes.

| Component | Main estimate | Repeat estimate | Difference | Interval on difference |
|---|---|---|---|---|
| LV-U | TBD | TBD | TBD | TBD |
| LV-P | TBD | TBD | TBD | TBD |
| LV-C | TBD | TBD | TBD | TBD |
| LV-L | TBD | TBD | TBD | TBD |
