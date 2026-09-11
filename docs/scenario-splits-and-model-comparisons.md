# Scenario Splits and Model Comparisons

Version: 1  
Frozen for D04: 2026-09-11 UTC  
Canonical manifest: `protocols/scenario-split-and-model-comparison.v1.json`

## Split decision

The numeric referential generator uses two attributes with four values each, for 16
semantic type codes. Type code `4a + b` represents attribute pair `(a, b)`. The four
diagonal combinations `[0, 5, 10, 15]` form the untouched compositional test set.
Every attribute value occurs in the 12-code seen pool and once in the held-out set,
so success cannot depend on an attribute value that was itself absent from training.

| Split | Target support | Candidate support | Learning | Permitted use |
|---|---|---|---|---|
| Train | 12 non-diagonal codes | 12 non-diagonal codes | Enabled | Parameter updates only |
| Validation | Same 12 seen codes, independent split PRNG domain | 12 non-diagonal codes | Disabled | Tuning, stopping-rule application, and baseline selection |
| Held-out test | Four diagonal codes | All codes; held-out target is present | Disabled | One locked confirmatory evaluation after tuning freezes |
| Evaluation | All codes | All codes | Disabled | Engineering and qualification only; never the confirmatory test |

The prior engine excluded held-out codes only as training targets. It could expose an
unseen combination as a distractor in a learner's training observation. That is a
real compositional-test leak. The D04 implementation restricts every training and
validation candidate to the seen pool and adds a separate validation PRNG domain.

Train and validation deliberately share semantic type support because validation is
an in-distribution tuning split. They may not share exact `scenarioRef` or `stateHash`
instances. Held-out semantic targets may not appear anywhere in train/validation,
including distractors. Asset-backed bundles additionally require normalized-byte and
semantic-identifier deduplication; perceptual near-duplicate thresholds must be
registered when such a bundle is introduced and are not invented for the current
numeric generator.

## Matched comparisons

| Comparison | Interpretation | Required matching | Deliberate difference |
|---|---|---|---|
| E11/E12 recurrent mechanism | Within-architecture causal | Independent 4,049-parameter per-role GRUs, initialization namespaces, scenarios, carrier/capacity, episodes, turns, update opportunities, evaluation and interventions | Learning signal and its necessary loss |
| E15 bandwidth | Within-architecture causal | Recurrent architecture, initialization, scenarios, exposure, updates, evaluation, compute ceiling | 32-symbol/4-token versus 128-symbol/8-token channel |
| E13/E14 carrier | Within-architecture causal | Recurrent learner, eight selectable slots, 3-bit effective one-mark capacity, scenarios, updates, evaluation | Physical token/glyph/bitmap/stroke/tone grammar |
| E20 affect | Within-architecture causal | Frozen policies, scenarios, windows, cardinality, timing, repair opportunities | Registered affect mapping |
| E30 partner training | Within-architecture causal for primary contrast | Total episodes, total updates, scenarios, evaluation, adaptation | Fixed dyad versus eight-partner round robin |
| E32 incentive | Within-architecture causal | Frozen cooperative start, scenarios, channel, information boundary, budget | Utilities, reservations, private-information condition |
| Frozen model or different architecture versus recurrent model | Cross-architecture descriptive | Scenario/channel/evaluation accounting where supported | Pretraining, scale, tokenizer, memory, runtime, and optimization |

Budget matching is multidimensional. Equal wall-clock duration is not a substitute
for equal training episodes, environment turns, optimizer updates, examples per
update, evaluation episodes, intervention opportunities, effective channel capacity,
and trainable parameters where architectures are shared. Measured compute time and
peak memory are reported, not silently used as outcome-dependent stopping rules.

E30's eight-partner arm receives the same total interaction and update budget as the
fixed dyad, so each training partner receives one eighth of the exposure. Both total
exposure and per-partner exposure must be reported; calling the arms “matched” without
both quantities would conceal the central tradeoff.

## Executable checks

`pnpm audit:scenario-design` checks the manifest partitions, diagonal balance,
comparison classifications, required budget dimensions, and 2,000 generated episodes
per split. It fails if a held-out type enters any training/validation candidate list,
if a held-out target enters those splits, if exact state/reference hashes overlap, or
if any held-out type is missing from the held-out target sample. Focused scenario
tests independently cover the same runtime behavior.

D04 is complete for the numeric generator and declared model comparisons. It does
not set seed counts, power, resource ceilings, or asset near-duplicate thresholds;
those are explicit D05/D07 or future asset-bundle registration parameters.

