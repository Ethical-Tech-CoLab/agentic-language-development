# Statistical Validation and Power Design

Version: 1  
Frozen for D05: 2026-09-11 UTC  
Canonical protocol: `protocols/statistical-analysis-and-power.v1.json`

## Evidence boundary

This is outcome-blind design evidence. It validates calculations and prospective
operating characteristics; it contains no agent experiment result. The independent
implementation is base R 4.6.1 installed through Homebrew. Its 66-row receipt is
`reports/research/statistical-validation.tsv`. `pnpm audit:statistics` compares 28
production values with the frozen R references and enforces every declared simulation
finding. `pnpm audit:statistics:r` regenerates the receipt in a temporary directory
with R and requires byte identity.

## Numerical agreement

The production implementation agrees within `1e-10` with independent values for
normal and Student-t quantiles/CDFs, one-sample and Welch t tests, both TOST components,
Holm adjustment, a Wilson interval, an exact binomial tail, type-7 quantiles,
log-beta, plug-in and Miller-Madow entropy/mutual information, and an overdispersed
beta-binomial fit.
These checks exercise the special functions underneath the higher-level analyses,
not merely their final booleans.

## Coverage, boundaries, and clustering

| Stress case | Estimate | 95% Monte Carlo interval | Decision |
|---|---:|---:|---|
| Wilson coverage, binomial `p=0.25`, 200 episodes | 0.9592 | [0.9569, 0.9613] | Accept as descriptive interval |
| Seed-t coverage, 25 beta-binomial seeds, latent SD 0.05 | 0.9523 | [0.9498, 0.9547] | Accept as primary seed-level interval |
| Percentile-bootstrap coverage, same case, 999 resamples | 0.9335 | [0.9217, 0.9436] | Sensitivity only; upper bound is below nominal 0.95 |
| Pooled-episode Type I under seed clustering | 0.3081 | [0.3029, 0.3133] | Reject for inference |
| Seed-level Type I under the same clustering | 0.0406 | [0.0384, 0.0429] | Accept |

At the lower and upper TOST boundaries, false-equivalence point estimates ranged
from 0.0071 to 0.0109 across the four seed counts at per-test alpha 0.01. The result
supports the implemented seed-level TOST rule and does not license episode-level
pseudoreplication.

## E03 amendment and full-rule power

The former E03 rule rejected a condition when more than 5% of observed seed rates
were at least 0.35. That count was a useful diagnostic but not a calibrated test. A
bounded beta-binomial simulation found only 0.0722 probability of satisfying the cap
in the lowest-variance row and zero observed passes in 10,000 repetitions of each
higher-variance row. Its complete-rule power was therefore at most 0.0705.

The rule is amended before registration:

- the seed/run remains the independent unit;
- five control TOST p-values receive Holm correction at family-wise alpha 0.05;
- oracle adequacy uses a one-sided seed-level t lower bound above 0.90;
- five paired oracle-minus-control tests above 0.60 receive Holm correction, with
  conservative 99% Bonferroni lower bounds reported;
- bootstrap intervals remain sensitivity outputs;
- every non-oracle seed at or above 0.35 triggers case-level leakage review, while
  the number of triggers is not itself a statistical rejection;
- evidence verification and a clean leakage disposition remain mandatory external
  validity gates.

| Latent seed SD | Seeds/condition | Full numeric-rule power | 95% Monte Carlo interval |
|---:|---:|---:|---:|
| 0.05 | 25 | 0.9318 | [0.9267, 0.9366] |
| 0.10 | 75 | 0.9308 | [0.9257, 0.9356] |
| 0.15 | 155 | 0.9163 | [0.9107, 0.9216] |
| 0.20 | 300 | 0.9552 | [0.9510, 0.9591] |

All lower bounds exceed 0.90. The beta-binomial generator samples a bounded latent
seed probability and then 200 binary episodes, so it does not rely on impossible
normal rates outside `[0,1]`.

## Invalid runs

Ordered reserves handle prespecified validity failures; they never replace an
unfavorable valid outcome. With N=75 and eight reserves per condition, the modeled
probability that all six conditions avoid reserve exhaustion is 0.9999 at a 2%
invalid probability, 0.9277 at 5%, and 0.0871 at 10%. Thus a measured invalid rate
near 10% blocks the current allocation rather than inviting unregistered extension.

The required invalid-as-failure sensitivity is intentionally severe. Replacing 5%
of N=75 observations with zero drove simulated full-rule power to zero because it
also degrades the oracle. It must be reported alongside complete-case analysis, but
it is not the primary estimand and cannot be used to relabel invalid runs as valid.

## Nine-member confirmatory family

Global Holm materially changes sample-size reasoning. Under nine independent
one-sided standardized tests, N=75 provides only 0.6752 probability that all nine
reject when the true standardized effect is 0.40. N=100 raises that estimate to
0.9068 with lower 95% Monte Carlo bound 0.9035. Conversely, even N=150 reaches only
0.8017 for effect 0.30.

These are sensitivity values, not universal seed counts. Each frozen raw-scale
margin and blinded-pilot upper variance must feed a member-specific complete
test, including composites and missingness. The original
[selection clarification](../protocols/confirmatory-family-selection-amendment.v1.json)
resolved candidate ordering but gave the complete nine-member joint simulation
selection authority. The later dependence and confidence amendments supersede that
authority: the first ordered shared candidate must pass the simultaneously bounded
member-power union and corrected reserve gate. The joint result remains diagnostic.
Neither the ten-seed floor nor the historical 75-seed convention is evidence of power.

The machine-checked
[`confirmatory-design-readiness.v1.json`](../protocols/confirmatory-design-readiness.v1.json)
inventory fails closed before that selector. It currently records all nine
operationalized estimands. H5's `stable-convention/v1` still needs prospective
window/listening thresholds and H8's `negotiation-language/v1` registered spaces are
now fixed with all nine scale-specific margins in the outcome-blind
[`confirmatory-practical-margins.v1.json`](../protocols/confirmatory-practical-margins.v1.json)
policy. Zero family pilots and zero joint-family repetitions exist, so these choices
are design commitments rather than empirical support.

The `confirmatory-pilot-summary/v2` software contract enumerates the seven distinct
experiment pilots, their nine member mappings, and fourteen component summaries.
It distinguishes not-collected, incomplete, and complete states; requires twenty
valid primary slots and a conservative upper dispersion bound for every component;
and refuses selection eligibility for partial, invalid, or confirmatory-reused pilot
data. For every experiment it recomputes the one-sided 95% Wilson-score upper bound
on invalid-run probability. With zero invalid runs in twenty slots that bound remains
about 0.119, so zero observed failures cannot be entered as zero reserve risk.

Marginal pilot SDs do not identify dependence among the fourteen component tests.
The prospective
[`confirmatory-power-model-amendment.v1.json`](../protocols/confirmatory-power-model-amendment.v1.json)
therefore makes selection dependence-robust: each complete member must pass at the
0.05/9 screen, Wilson lower member-power bounds feed a union lower bound for all
nine decisions, and reserve adequacy must be at least 0.95 at the pilot upper invalid
rate. A modeled joint result is reported diagnostically but cannot select a smaller N.

Nine separately computed 95% member intervals do not provide 95% simultaneous
coverage. The prospective
[`confirmatory-power-confidence-amendment.v1.json`](../protocols/confirmatory-power-confidence-amendment.v1.json)
first corrected that member-level error. The later
[`confirmatory-component-power-amendment.v1.json`](../protocols/confirmatory-component-power-amendment.v1.json)
also removes unidentified dependence inside composite H1, H5, and H8. The controlling
selector allocates one-sided alpha `0.05/14` to all fourteen component-power bounds
(equivalent two-sided Wilson confidence `0.992857...`), forms member and family union
bounds, requires every candidate/component count, rejects an ineligible pilot, and
cannot promote a member or joint diagnostic.

The prospective
[`confirmatory-validity-reserve-amendment.v1.json`](../protocols/confirmatory-validity-reserve-amendment.v1.json)
corrects the original fixed 10% reserve rule for the seven confirmatory experiments.
For each candidate it uses the exact binomial CDF and chooses the smallest reserve
count whose probability of yielding N valid runs is at least 0.95 at the experiment's
pilot upper invalid rate. With a clean 0/20 pilot, the machine-checked reference ranges
from 7 reserves for N=25 to 52 for N=300. These rows are outcome-blind design bounds;
they do not authorize resources, allocate seeds, or select N.

The prospective
[`confirmatory-power-simulator.v1.json`](../protocols/confirmatory-power-simulator.v1.json)
specifies the deterministic executable model for all eight candidate sizes and all
fourteen component tests. Continuous components use their frozen alternatives and
the eligible pilot's conservative upper SD under a Normal sufficient-statistic
model; H5 uses exact-binomial decision probabilities. Each candidate/member/component
has a derived random stream. A complete-family count produced from independent
component streams is explicitly diagnostic-only, while the selector consumes the
component counts. The Normal model is an assumption for power planning, not a claim
about observed distributions, and fixture execution is never a campaign power result.

The retained
[`confirmatory-power-simulator-qualification-receipt.json`](../reports/research/confirmatory-power-simulator-qualification-receipt.json)
binds the exact v0.1.198 implementation, source artifacts, fixture seed, and output
digest. Its 112 candidate/component proportions were checked against independent R
4.6.1 noncentral-t and exact-binomial power values; the maximum deviation was 2.55
Monte Carlo standard errors under a prespecified five-standard-error gate. The
receipt records no eligible pilot, selected N, campaign result, or resource approval.

The prospective
[`confirmatory-pilot-reduction.v1.json`](../protocols/confirmatory-pilot-reduction.v1.json)
binds a pure numerical reducer for seven complete twenty-slot pilot corpora. It
requires exact ordered component keys and distinct registration, run, seed, and
evidence identities, then computes each sample SD and a one-sided 95% upper SD
using the R-checked `sqrt(19 / qchisq(0.05, 19))` factor. Its summary is not an
admitted pilot: original bundle verification, packet ancestry, registered metric
derivation, and a separate admission receipt remain mandatory. Pilot means present
in the v2 numerical contract are prohibited inputs to design changes.

## Prospective E03 pilot reduction

The E03 pilot reducer accepts exactly twenty 200-episode seed tallies for each
of the five non-oracle controls. It fits the already qualified deterministic
beta-binomial grid model to each condition, converts each fitted precision to
latent between-seed standard deviation, and maps the largest value to E03's
four frozen Appendix D rows. A value above 0.20 returns no seed count and
requires a prospective amendment.

This reduction remains design input, not a qualification decision. It does not
run the chance-equivalence, oracle-adequacy, or separation tests, and its
point-estimate selection does not by itself establish power. Full registration
still requires the independently reproduced 30,000-repetition bounded
numeric-rule receipt and exact hashes for both the eligible pilot receipt and
that power receipt.

## Reproduction

```sh
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm audit:statistics
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm audit:statistics:r
```

D05 is complete at the method-validation level. It does not create final
hypothesis-specific seed allocations; those depend on disjoint pilot variances,
frozen raw-scale practical margins, and resource accounting in D07.
