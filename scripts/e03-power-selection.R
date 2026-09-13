#!/usr/bin/env Rscript

# Independent, base-R-only bounded power calculation for the E03 full numeric
# qualification rule. This consumes one outcome-blind pilot dispersion value;
# it does not read experiment outcomes or evaluate a scientific hypothesis.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 3L) {
  stop("usage: e03-power-selection.R <output.tsv> <largest-latent-sd> <primary-seeds>")
}
output <- args[[1]]
latent_sd <- as.numeric(args[[2]])
n <- as.integer(args[[3]])
rows <- data.frame(sd = c(0.05, 0.10, 0.15, 0.20), seeds = c(25L, 75L, 155L, 300L))
eligible_rows <- which(latent_sd <= rows$sd)
selected <- if (length(eligible_rows) == 0L) NA_integer_ else rows$seeds[eligible_rows[[1]]]
if (!is.finite(latent_sd) || latent_sd < 0 || latent_sd > 0.20 || is.na(selected) || n != selected) {
  stop("pilot dispersion and primary seed count do not match the frozen E03 table")
}

repetitions <- 30000L
simulation_seed <- 20260913L + n
set.seed(simulation_seed)

beta_shapes <- function(mean, sd) {
  precision <- mean * (1 - mean) / sd^2 - 1
  if (precision <= 0) stop("latent SD is infeasible for beta distribution")
  c(mean * precision, (1 - mean) * precision)
}

draw_rates <- function(mean, sd) {
  if (sd == 0) {
    return(matrix(rbinom(repetitions * n, 200L, mean) / 200, nrow = repetitions))
  }
  shape <- beta_shapes(mean, sd)
  latent <- matrix(rbeta(repetitions * n, shape[[1]], shape[[2]]), nrow = repetitions)
  matrix(rbinom(repetitions * n, 200L, latent) / 200, nrow = repetitions)
}

row_sd <- function(x) {
  means <- rowMeans(x)
  sqrt(pmax(0, (rowSums(x^2) - n * means^2) / (n - 1L)))
}

one_sided_p <- function(x, null, alternative) {
  statistic <- (rowMeans(x) - null) / (row_sd(x) / sqrt(n))
  if (alternative == "greater") {
    pt(statistic, n - 1L, lower.tail = FALSE)
  } else {
    pt(statistic, n - 1L)
  }
}

tost_p <- function(x) {
  pmax(one_sided_p(x, 0.20, "greater"), one_sided_p(x, 0.30, "less"))
}

all_holm_rejected <- function(p_matrix, alpha = 0.05) {
  ordered <- t(apply(p_matrix, 1L, sort))
  thresholds <- alpha / rev(seq_len(ncol(ordered)))
  rowSums(sweep(ordered, 2L, thresholds, `<=`)) == ncol(ordered)
}

wilson <- function(successes, total) {
  z <- qnorm(0.975)
  p <- successes / total
  denominator <- 1 + z^2 / total
  center <- (p + z^2 / (2 * total)) / denominator
  half <- z / denominator * sqrt(p * (1 - p) / total + z^2 / (4 * total^2))
  c(max(0, center - half), min(1, center + half))
}

controls <- lapply(seq_len(5L), function(unused) draw_rates(0.25, latent_sd))
oracle <- draw_rates(0.98, 0.01)
control_p <- do.call(cbind, lapply(controls, tost_p))
controls_pass <- all_holm_rejected(control_p)
oracle_pass <- one_sided_p(oracle, 0.90, "greater") < 0.05
separation_p <- do.call(cbind, lapply(
  controls,
  function(control) one_sided_p(oracle - control, 0.60, "greater")
))
separation_pass <- all_holm_rejected(separation_p)
numeric_pass <- controls_pass & oracle_pass & separation_pass
numeric_successes <- sum(numeric_pass)
numeric_interval <- wilson(numeric_successes, repetitions)

invalid_count <- ceiling(0.05 * n)
worst_controls <- lapply(controls, function(control) {
  control[, seq_len(invalid_count)] <- 0
  control
})
worst_oracle <- oracle
worst_oracle[, seq_len(invalid_count)] <- 0
worst_control_p <- do.call(cbind, lapply(worst_controls, tost_p))
worst_controls_pass <- all_holm_rejected(worst_control_p)
worst_oracle_pass <- one_sided_p(worst_oracle, 0.90, "greater") < 0.05
worst_separation_p <- do.call(cbind, lapply(
  worst_controls,
  function(control) one_sided_p(worst_oracle - control, 0.60, "greater")
))
worst_separation_pass <- all_holm_rejected(worst_separation_p)
worst_successes <- sum(worst_controls_pass & worst_oracle_pass & worst_separation_pass)
worst_interval <- wilson(worst_successes, repetitions)

result <- data.frame(
  largest_latent_pilot_sd = latent_sd,
  primary_seeds = n,
  repetitions = repetitions,
  simulation_seed = simulation_seed,
  numeric_successes = numeric_successes,
  numeric_power = numeric_successes / repetitions,
  numeric_lower95 = numeric_interval[[1]],
  numeric_upper95 = numeric_interval[[2]],
  invalid_as_failure_count = invalid_count,
  invalid_as_failure_successes = worst_successes,
  invalid_as_failure_power = worst_successes / repetitions,
  invalid_as_failure_lower95 = worst_interval[[1]],
  invalid_as_failure_upper95 = worst_interval[[2]]
)
write.table(result, output, sep = "\t", row.names = FALSE, quote = FALSE)
