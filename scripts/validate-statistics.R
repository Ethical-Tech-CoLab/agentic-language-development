#!/usr/bin/env Rscript

# Independent numerical and operating-characteristic validation for D05.
# This script intentionally uses only base R so its distribution functions,
# random generators, and interval implementations are independent of the
# TypeScript analysis package. It produces design evidence, never study data.

args <- commandArgs(trailingOnly = TRUE)
output <- if (length(args) >= 1) args[[1]] else "reports/research/statistical-validation.tsv"

set.seed(20260911)

rows <- list()
add_row <- function(category, case, metric, value, mc_n = NA_integer_,
                    lower95 = NA_real_, upper95 = NA_real_) {
  rows[[length(rows) + 1]] <<- data.frame(
    category = category,
    case = case,
    metric = metric,
    value = value,
    mc_n = mc_n,
    lower95 = lower95,
    upper95 = upper95,
    stringsAsFactors = FALSE
  )
}

mc_interval <- function(successes, n, confidence = 0.95) {
  z <- qnorm(1 - (1 - confidence) / 2)
  p <- successes / n
  denominator <- 1 + z^2 / n
  center <- (p + z^2 / (2 * n)) / denominator
  half <- z / denominator * sqrt(p * (1 - p) / n + z^2 / (4 * n^2))
  c(max(0, center - half), min(1, center + half))
}

add_mc <- function(category, case, metric, successes, n) {
  ci <- mc_interval(successes, n)
  add_row(category, case, metric, successes / n, n, ci[[1]], ci[[2]])
}

# Frozen numerical reference values for production functions.
sample_values <- c(0.24, 0.26, 0.25, 0.23, 0.27)
t_result <- t.test(sample_values + 0.10, mu = 0.25, alternative = "greater")
tost_lower <- t.test(sample_values, mu = 0.20, alternative = "greater")$p.value
tost_upper <- t.test(sample_values, mu = 0.30, alternative = "less")$p.value
wilson <- prop.test(8, 10, conf.level = 0.95, correct = FALSE)$conf.int

add_row("reference", "normal", "qnorm-0.975", qnorm(0.975))
add_row("reference", "student-t", "qt-0.975-df10", qt(0.975, 10))
add_row("reference", "student-t", "pt-2.228138851964-df10", pt(2.228138851964, 10))
add_row("reference", "one-sample-t", "t", unname(t_result$statistic))
add_row("reference", "one-sample-t", "p-greater", t_result$p.value)
add_row("reference", "tost", "p-lower", tost_lower)
add_row("reference", "tost", "p-upper", tost_upper)
add_row("reference", "tost", "p-max", max(tost_lower, tost_upper))
holm <- p.adjust(c(0.01, 0.04, 0.03, 0.005), method = "holm")
for (i in seq_along(holm)) add_row("reference", "holm", paste0("adjusted-", i), holm[[i]])
add_row("reference", "wilson-8-of-10", "lower", wilson[[1]])
add_row("reference", "wilson-8-of-10", "upper", wilson[[2]])
add_row("reference", "binomial-4-of-5", "greater-p", pbinom(3, 5, 0.5, lower.tail = FALSE))
add_row("reference", "quantile-type7", "q-0.025", quantile(c(0, 1, 2, 3, 4), 0.025, type = 7, names = FALSE))
add_row("reference", "quantile-type7", "q-0.975", quantile(c(0, 1, 2, 3, 4), 0.975, type = 7, names = FALSE))
add_row("reference", "special", "lbeta-2-3", lbeta(2, 3))

welch <- t.test(
  c(1.2, 1.5, 1.7, 1.9, 2.2),
  c(0.8, 1.0, 1.1, 1.3, 1.4, 1.5),
  alternative = "greater",
  var.equal = FALSE
)
add_row("reference", "welch", "t", unname(welch$statistic))
add_row("reference", "welch", "df", unname(welch$parameter))
add_row("reference", "welch", "p-greater", welch$p.value)

entropy_bits <- function(counts) {
  probabilities <- counts[counts > 0] / sum(counts)
  -sum(probabilities * log2(probabilities))
}
miller_madow_bits <- function(counts) {
  entropy_bits(counts) + (sum(counts > 0) - 1) / (2 * sum(counts) * log(2))
}
add_row("reference", "entropy-2-3-5", "plugin-bits", entropy_bits(c(2, 3, 5)))
add_row("reference", "entropy-2-3-5", "miller-madow-bits", miller_madow_bits(c(2, 3, 5)))
joint <- matrix(c(10, 0, 0, 10), nrow = 2, byrow = TRUE)
plugin_mi <- entropy_bits(rowSums(joint)) + entropy_bits(colSums(joint)) - entropy_bits(as.vector(joint))
mm_mi <- miller_madow_bits(rowSums(joint)) + miller_madow_bits(colSums(joint)) - miller_madow_bits(as.vector(joint))
add_row("reference", "mutual-information-perfect-binary", "plugin-bits", plugin_mi)
add_row("reference", "mutual-information-perfect-binary", "miller-madow-bits", mm_mi)

beta_successes <- c(1, 9, 2, 8, 5)
beta_trials <- rep(10, 5)
negative_beta_binomial_log_likelihood <- function(parameters) {
  mu <- plogis(parameters[[1]])
  precision <- exp(parameters[[2]])
  alpha <- mu * precision
  beta <- (1 - mu) * precision
  -sum(
    lchoose(beta_trials, beta_successes) +
      lbeta(beta_successes + alpha, beta_trials - beta_successes + beta) -
      lbeta(alpha, beta)
  )
}
beta_fit <- optim(c(0, log(2.5)), negative_beta_binomial_log_likelihood, method = "BFGS", control = list(reltol = 1e-13))
add_row("reference", "beta-binomial-overdispersed", "mu", plogis(beta_fit$par[[1]]))
add_row("reference", "beta-binomial-overdispersed", "precision", exp(beta_fit$par[[2]]))
add_row("reference", "beta-binomial-overdispersed", "log-likelihood", -beta_fit$value)

beta_shapes <- function(mean, latent_sd) {
  precision <- mean * (1 - mean) / latent_sd^2 - 1
  if (precision <= 0) stop("latent SD is infeasible for beta distribution")
  c(mean * precision, (1 - mean) * precision)
}

draw_rates <- function(repetitions, seeds, mean, latent_sd, episodes) {
  shape <- beta_shapes(mean, latent_sd)
  latent <- matrix(rbeta(repetitions * seeds, shape[[1]], shape[[2]]), nrow = repetitions)
  matrix(rbinom(repetitions * seeds, episodes, latent) / episodes, nrow = repetitions)
}

row_sd <- function(x) {
  n <- ncol(x)
  means <- rowMeans(x)
  sqrt(pmax(0, (rowSums(x^2) - n * means^2) / (n - 1)))
}

one_sided_p <- function(x, null, alternative) {
  n <- ncol(x)
  means <- rowMeans(x)
  se <- row_sd(x) / sqrt(n)
  statistic <- (means - null) / se
  if (alternative == "greater") pt(statistic, n - 1, lower.tail = FALSE) else pt(statistic, n - 1)
}

tost_p <- function(x, lower, upper) {
  pmax(one_sided_p(x, lower, "greater"), one_sided_p(x, upper, "less"))
}

all_holm_rejected <- function(p_matrix, alpha = 0.05) {
  apply(p_matrix, 1, function(p) all(p.adjust(p, method = "holm") <= alpha))
}

# Interval coverage for bounded episode outcomes.
coverage_repetitions <- 30000L
counts <- rbinom(coverage_repetitions, 200, 0.25)
z <- qnorm(0.975)
observed <- counts / 200
denominator <- 1 + z^2 / 200
centers <- (observed + z^2 / 400) / denominator
halves <- z / denominator * sqrt(observed * (1 - observed) / 200 + z^2 / (4 * 200^2))
add_mc("coverage", "wilson-binomial-p0.25-n200", "contains-true-mean",
       sum(centers - halves <= 0.25 & centers + halves >= 0.25), coverage_repetitions)

seed_samples <- draw_rates(coverage_repetitions, 25, 0.25, 0.05, 200)
seed_means <- rowMeans(seed_samples)
seed_half <- qt(0.975, 24) * row_sd(seed_samples) / 5
add_mc("coverage", "seed-t-beta-binomial-n25-sd0.05", "contains-true-mean",
       sum(seed_means - seed_half <= 0.25 & seed_means + seed_half >= 0.25), coverage_repetitions)

bootstrap_repetitions <- 2000L
bootstrap_iterations <- 999L
bootstrap_covered <- logical(bootstrap_repetitions)
bootstrap_samples <- draw_rates(bootstrap_repetitions, 25, 0.25, 0.05, 200)
for (i in seq_len(bootstrap_repetitions)) {
  values <- bootstrap_samples[i, ]
  indices <- matrix(sample.int(25, 25 * bootstrap_iterations, replace = TRUE), nrow = bootstrap_iterations)
  means <- rowMeans(matrix(values[indices], nrow = bootstrap_iterations))
  interval <- quantile(means, c(0.025, 0.975), type = 7, names = FALSE)
  bootstrap_covered[[i]] <- interval[[1]] <= 0.25 && interval[[2]] >= 0.25
}
add_mc("coverage", "percentile-bootstrap-beta-binomial-n25-sd0.05-b999", "contains-true-mean",
       sum(bootstrap_covered), bootstrap_repetitions)

# TOST size at both equivalence boundaries. Declaring equivalence at a boundary
# is a false positive, so each estimate must remain at or below alpha within MC uncertainty.
boundary_repetitions <- 30000L
for (n in c(25L, 75L, 155L, 300L)) {
  lower_data <- draw_rates(boundary_repetitions, n, 0.20, 0.05, 200)
  upper_data <- draw_rates(boundary_repetitions, n, 0.30, 0.05, 200)
  add_mc("type-i", paste0("tost-lower-bound-n", n), "declares-equivalence-alpha0.01",
         sum(tost_p(lower_data, 0.20, 0.30) < 0.01), boundary_repetitions)
  add_mc("type-i", paste0("tost-upper-bound-n", n), "declares-equivalence-alpha0.01",
         sum(tost_p(upper_data, 0.20, 0.30) < 0.01), boundary_repetitions)
}

# Pseudoreplication stress test: a pooled episode test ignores the beta-binomial
# seed clustering, while the seed-level t test uses the independent unit.
cluster_repetitions <- 30000L
clustered <- draw_rates(cluster_repetitions, 25, 0.25, 0.10, 200)
pooled_successes <- rowSums(clustered * 200)
pooled_p <- pbinom(pooled_successes - 1, 25 * 200, 0.25, lower.tail = FALSE)
seed_p <- one_sided_p(clustered, 0.25, "greater")
add_mc("clustering", "beta-binomial-n25-sd0.10", "pooled-episode-type-i",
       sum(pooled_p < 0.05), cluster_repetitions)
add_mc("clustering", "beta-binomial-n25-sd0.10", "seed-level-type-i",
       sum(seed_p < 0.05), cluster_repetitions)

# Full E03 numerical rule under bounded beta-binomial data. The five control
# equivalence p-values and five oracle-separation p-values each receive Holm
# correction; oracle adequacy is a one-sided seed-level t test. The old 5%
# high-seed cap is reported separately because it is a diagnostic tail rule,
# not a level-controlled test.
design_repetitions <- 10000L
design_rows <- data.frame(latent_sd = c(0.05, 0.10, 0.15, 0.20), seeds = c(25L, 75L, 155L, 300L))
for (row in seq_len(nrow(design_rows))) {
  latent_sd <- design_rows$latent_sd[[row]]
  n <- design_rows$seeds[[row]]
  controls <- lapply(seq_len(5), function(unused) draw_rates(design_repetitions, n, 0.25, latent_sd, 200))
  oracle <- draw_rates(design_repetitions, n, 0.98, 0.01, 200)
  control_p <- do.call(cbind, lapply(controls, tost_p, lower = 0.20, upper = 0.30))
  controls_pass <- all_holm_rejected(control_p)
  oracle_pass <- one_sided_p(oracle, 0.90, "greater") < 0.05
  separation_p <- do.call(cbind, lapply(controls, function(control) one_sided_p(oracle - control, 0.60, "greater")))
  separation_pass <- all_holm_rejected(separation_p)
  numeric_pass <- controls_pass & oracle_pass & separation_pass
  old_tail_pass <- Reduce(`&`, lapply(controls, function(control) rowMeans(control >= 0.35) <= 0.05))
  label <- sprintf("n%d-latent-sd%.2f", n, latent_sd)
  add_mc("full-e03", label, "numeric-rule-power", sum(numeric_pass), design_repetitions)
  add_mc("full-e03", label, "old-high-tail-cap-pass", sum(old_tail_pass), design_repetitions)
  add_mc("full-e03", label, "old-complete-rule-power", sum(numeric_pass & old_tail_pass), design_repetitions)

  if (n == 75L && abs(latent_sd - 0.10) < 1e-12) {
    invalid_count <- ceiling(0.05 * n)
    worst_controls <- lapply(controls, function(control) {
      control[, seq_len(invalid_count)] <- 0
      control
    })
    worst_oracle <- oracle
    worst_oracle[, seq_len(invalid_count)] <- 0
    worst_control_p <- do.call(cbind, lapply(worst_controls, tost_p, lower = 0.20, upper = 0.30))
    worst_controls_pass <- all_holm_rejected(worst_control_p)
    worst_oracle_pass <- one_sided_p(worst_oracle, 0.90, "greater") < 0.05
    worst_separation_p <- do.call(cbind, lapply(worst_controls, function(control) one_sided_p(worst_oracle - control, 0.60, "greater")))
    worst_separation_pass <- all_holm_rejected(worst_separation_p)
    add_mc("invalid-runs", "n75-sd0.10-five-percent-as-failures", "numeric-rule-power",
           sum(worst_controls_pass & worst_oracle_pass & worst_separation_pass), design_repetitions)
  }
}

for (invalid_probability in c(0.02, 0.05, 0.10)) {
  primary <- 75L
  reserves <- ceiling(0.10 * primary)
  one_condition <- pbinom(reserves, primary, invalid_probability)
  add_row("invalid-runs", sprintf("n75-reserve8-q%.2f", invalid_probability),
          "all-six-conditions-avoid-reserve-exhaustion", one_condition^6)
}

# Family-level sensitivity for nine independent one-sided seed-level tests.
# This does not select N because hypothesis-specific practical margins and pilot
# SDs remain prerequisites; it makes the global-Holm cost explicit for D07.
family_repetitions <- 30000L
for (n in c(75L, 100L, 150L)) {
  for (standardized_effect in c(0.30, 0.40, 0.50)) {
    p_values <- matrix(NA_real_, nrow = family_repetitions, ncol = 9)
    for (member in seq_len(9)) {
      sample <- matrix(rnorm(family_repetitions * n, standardized_effect, 1), nrow = family_repetitions)
      p_values[, member] <- one_sided_p(sample, 0, "greater")
    }
    passed <- all_holm_rejected(p_values)
    label <- sprintf("n%d-d%.2f", n, standardized_effect)
    add_mc("confirmatory-family", label, "all-nine-holm-power", sum(passed), family_repetitions)
  }
}

result <- do.call(rbind, rows)
dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
write.table(result, output, sep = "\t", row.names = FALSE, quote = FALSE, na = "")
cat(sprintf("Wrote %s (%d validation rows) with R %s\n", output, nrow(result), getRversion()))
