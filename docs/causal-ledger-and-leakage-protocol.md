# Causal Ledger and Leakage Protocol

Status: D06 design frozen; no study outcomes

The machine-readable source of truth is
`protocols/causal-ledger-and-leakage.v1.json`. This document explains the
decision boundary and the independent operating-characteristic receipt in
`reports/research/leakage-design-validation.tsv`.

## Ledger chronology and claims

E15/E16 predictions must be genuinely prospective. Training ends first. The
receiver policies freeze, and only training-period native-ledger events may
feed the versioned prediction function. The validation-selected comparator,
ordered probe schedule, native predictions, comparator predictions, and
function version are committed to the intervention chain and checkpointed
before the first held-out outcome exists.

H2 is behavioral and causal: on paired held-out cases it estimates the
seed-level target-action probability change caused by a ledger-consistent
message rather than a shuffled valid message. Receiver observations, candidate
order, policy bytes, recurrent state, scenario slot, and delivery envelope must
match within a pair. Probe cases are repeated measures; the seed/run is the
independent unit.

H4 is predictive and incremental: it compares the frozen native-ledger
predictor with one non-ledger comparator selected on validation data, then
scores both once on untouched test cases using multiclass Brier score. The
candidate baselines are uniform, validation-majority, transcript-only,
task-history, and frozen-policy-state predictors. The oracle is a diagnostic
positive control and cannot be selected. Learner-native state, generated
post-run interpretations, and human coding remain separate evidence classes.

## Leakage decision principle

Absence of a significant association does not establish absence of leakage. A
negative result is eligible only when it has all three of the following:

1. an explicit allowed/forbidden information set and practical margin;
2. a powered uncertainty bound below that margin; and
3. a planted violation detected through the same analysis boundary.

E01 forbids all routes around the normalized Gateway observation: peer
process, filesystem, network, IPC, cache, environment, tools, errors, timing,
and variable envelope size. Each attacked path needs a detector-positive
fixture. A passing audit means no prohibited delivery in the tested topology;
it is not a universal isolation claim.

E02 targets four-way human semantic labels. A strict track may receive only
the declared numeric sensory data, candidate set/order, and configured carrier
payload. Human labels, target answers, semantic identifiers, captions, paths,
OCR text, target-coded metadata, text tokenizers, and text-aligned encoders are
forbidden. The primary rule uses at least 200 untouched test rows and requires
the one-sided 95% Wilson upper bound on accuracy advantage over the held-out
majority baseline to be at most 0.10. A one-hot target-feature fixture must
have a lower advantage bound of at least 0.20. The shuffled-label interval is
diagnostic only.

E13 distinguishes communication from leakage. Ink density, stroke structure,
pitch, duration, and reusable normalized form identity are the intended
carrier. Their association with referents is a form-use/bandwidth diagnostic,
not a side channel. Hidden metadata, timing, variable envelopes, undeclared
dimensions/sample rates, container artifacts, and recognizable prior glyph
semantics remain forbidden and must be probed separately.

E20 permits only a fixed post-outcome display and the declared binary outcome
context. Referent identity, target action, task identity, pre-outcome delivery,
timing, sequences, combinations, and envelope variation are forbidden. For
each seed, analysis subtracts the mean of 1,000 within-outcome permutation CMI
values from observed Miller-Madow conditional mutual information. With at
least 75 eligible seeds and 1,000 windows per seed, the primary negative gate
is a one-sided 95% seed-level Student-t upper bound below 0.02 bits. The
percentile seed bootstrap is sensitivity-only.

## Outcome-blind design validation

The base-R receipt contains six exact operating-characteristic calculations.
At E02's 200-row test size, a true chance probe clears the 0.10 advantage
margin with probability 0.9157, boundary false clearance is 0.0426, and the
deterministic one-hot positive control is detected with probability 1. At
E20's 75-seed design, assuming normally distributed seed excess CMI with SD no
greater than 0.04 bits, zero excess clears with probability 0.9959, boundary
Type I error is 0.05, and a 0.04-bit planted mean is rejected as non-clear with
probability above 0.99999999.

The E20 variance assumption is a design constraint, not a finding. A blinded
pilot must estimate it before registration. If the uncertainty bound for SD
exceeds 0.04 bits, D07 must increase the seed count before outcomes are
unblinded. The portable audit checks hashes, decision floors, required
comparators, information sets, positive controls, and implementation markers;
`pnpm audit:causal-leakage:r` additionally reproduces the R receipt byte for
byte.
