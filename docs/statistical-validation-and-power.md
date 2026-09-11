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

These are sensitivity values, not universal seed counts. D07 must convert each
frozen raw-scale practical margin and pilot variance into a member-specific effect,
simulate its complete test including composite outcomes and missingness, and select
the largest resulting count whose lower Monte Carlo bound is at least 0.90. Neither
the ten-seed floor nor the historical 75-seed convention is evidence of power.

## Reproduction

```sh
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm audit:statistics
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm audit:statistics:r
```

D05 is complete at the method-validation level. It does not create final
hypothesis-specific seed allocations; those depend on disjoint pilot variances,
frozen raw-scale practical margins, and resource accounting in D07.
