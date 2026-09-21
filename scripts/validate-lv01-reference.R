#!/usr/bin/env Rscript

# Independent base-R numerical reference for the frozen LV01 power rules.
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 1L) stop("usage: validate-lv01-reference.R <upper-sd>")
sd <- as.numeric(args[[1]])
if (!is.finite(sd) || sd <= 0) stop("upper-sd must be positive and finite")

components <- data.frame(
  id = c("fidelity", "disabled", "constant", "random", "shuffled", "intervention"),
  alternative = c(-.01, .10, .10, .10, .10, .10),
  boundary = c(-.02, .05, .05, .05, .05, .05)
)
ns <- c(75L, 100L, 125L, 150L, 200L, 300L)
cat(sprintf("factor,%.17g\n", sqrt(19 / qchisq(.05 / 6, 19))))
for (n in ns) {
  critical <- qt(1 - .05 / 3, n - 1L)
  for (row in seq_len(nrow(components))) {
    delta <- (components$alternative[[row]] - components$boundary[[row]]) / sd
    power <- pt(critical, n - 1L, ncp = sqrt(n) * delta, lower.tail = FALSE)
    cat(sprintf("%d,%s,%.17g,%.17g\n", n, components$id[[row]], critical, power))
  }
}
