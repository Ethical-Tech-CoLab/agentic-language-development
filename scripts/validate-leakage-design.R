#!/usr/bin/env Rscript

# Independent, outcome-blind operating-characteristic calculations for D06.
# Base R is intentionally used so the receipt does not share implementation
# code with the TypeScript leakage evaluators.

args <- commandArgs(trailingOnly = TRUE)
output <- if (length(args) >= 1) args[[1]] else "reports/research/leakage-design-validation.tsv"

wilson_bounds <- function(successes, n, confidence = 0.90) {
  z <- qnorm(1 - (1 - confidence) / 2)
  observed <- successes / n
  denominator <- 1 + z^2 / n
  center <- (observed + z^2 / (2 * n)) / denominator
  half <- z / denominator * sqrt(observed * (1 - observed) / n + z^2 / (4 * n^2))
  c(max(0, center - half), min(1, center + half))
}

binomial_probability <- function(n, p, predicate) {
  counts <- 0:n
  sum(dbinom(counts[predicate(counts)], n, p))
}

n <- 200L
baseline <- 0.25
maximum_advantage <- 0.10
positive_minimum_advantage <- 0.20

negative_clearance <- function(counts) {
  vapply(counts, function(x) wilson_bounds(x, n)[[2]] <= baseline + maximum_advantage, logical(1))
}
positive_detection <- function(counts) {
  vapply(counts, function(x) wilson_bounds(x, n)[[1]] - baseline >= positive_minimum_advantage, logical(1))
}

e02_rows <- data.frame(
  experiment = "E02",
  case = c("chance-clearance", "margin-boundary-type-i", "positive-control-detection"),
  metric = c("probability-clear-bound", "probability-clear-bound", "probability-detect"),
  value = c(
    binomial_probability(n, 0.25, negative_clearance),
    binomial_probability(n, 0.35, negative_clearance),
    binomial_probability(n, 1, positive_detection)
  ),
  n = n,
  assumption = c(
    "true accuracy 0.25",
    "true accuracy 0.35",
    "deterministic injected target-label feature; true accuracy 1"
  ),
  stringsAsFactors = FALSE
)

affect_n <- 75L
affect_sd <- 0.04
affect_bound <- 0.02
alpha <- 0.05
critical <- qt(alpha, affect_n - 1)
clearance_power <- function(true_mean) {
  ncp <- (true_mean - affect_bound) * sqrt(affect_n) / affect_sd
  pt(critical, df = affect_n - 1, ncp = ncp)
}

e20_rows <- data.frame(
  experiment = "E20",
  case = c("zero-excess-clearance", "margin-boundary-type-i", "positive-control-detection"),
  metric = c("probability-clear-bound", "probability-clear-bound", "probability-not-clear"),
  value = c(
    clearance_power(0),
    clearance_power(affect_bound),
    1 - clearance_power(0.04)
  ),
  n = affect_n,
  assumption = c(
    "normal seed excess CMI; mean 0 bits; SD 0.04 bits",
    "normal seed excess CMI; mean 0.02 bits; SD 0.04 bits",
    "normal seed excess CMI; mean 0.04 bits; SD 0.04 bits"
  ),
  stringsAsFactors = FALSE
)

rows <- rbind(e02_rows, e20_rows)
options(digits = 16)
write.table(rows, output, sep = "\t", quote = FALSE, row.names = FALSE)
