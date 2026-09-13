# E02 observation qualification: implementation and evidence boundary

Status: exact prospective packet compiled; activation and execution pending. E02 is not qualified.

The collector uses actual scratch learners and the production SQLite-backed
Nursery, not a sink that pretends to be a learner. The explicit `prototype` mode
runs them in-process. The explicit `research-grade` mode uses isolated containers
and the unchanged 1,000 ms normalized response budget. Neither development mode
may be promoted to registered observations later.

## Development analysis design

The asset-free referential generator has two attributes, four values per attribute,
four candidate objects, and independent sender/receiver presentation shuffles.
The offline four-class label maps the target's first attribute to `red`, `green`,
`blue`, or `yellow`. These are researcher-only class names, not delivered words or
a claim that the learners recognize human color terms.

Each full development slot collects 816 training turns, takes a real policy/cursor/prefix
snapshot, closes and reopens the runtime against the original database, restores,
and collects another 816 turns. Two additional sealing turns are excluded from
the analysis by design. Each stage/role contributes 816 rows. This addresses the
provisional 800-row allocation's rounding risk: per-class floor rounding can leave
800 rows with fewer than 200 test cases, whereas 816 gives at least 201 across
four represented classes. This minimum does not by itself establish adequate
assurance for the complete planned 60-probe qualification.

| Probe | Frozen features | Excluded information |
| --- | --- | --- |
| Metadata | Turn index, sender/receiver role, numeric-array dimensions, serialized observation byte count, action count, candidate count, opaque ID nibbles | Sensory values, target flag, target type, outcome, offline label |
| Identifier | Scenario-reference nibbles and candidate-reference nibbles in delivered order, with zero padding where no candidates are exposed | Sensory values, target, outcomes, timing |
| Timing | Log-transformed measured duration of the actual `observe` call | Payload, identifiers, target, outcomes |

Timing is measured by the Nursery. It is a round-trip proxy, not a learner-side
clock trace or a complete scheduling-channel analysis. Observation and action-budget
schemas contain no scenario timestamp. Initialization configuration, contracts,
and provenance must also be inventoried; they are not per-scenario feature rows.

Three feature sets × two roles × two stages produce 12 separately reported probes.
Each uses the existing 400-epoch linear softmax implementation, a frozen seeded
stratified 75/25 split, and at least 200 untouched test rows. The one-sided 95%
Wilson upper accuracy bound minus held-out majority accuracy must be at most
0.10. The same learner/split with an appended offline one-hot target must have a
one-sided lower advantage of at least 0.20. Twenty label-shuffle fits are diagnostic
only. Every required probe must pass; no seed, role, stage, or feature is selected
after observing its result. The intersection rule does not turn these into a
universal absence-of-leakage claim.

### Prospective sample-size criticism

A separate ideal-null calculation, not a fit to the development held-out results,
examines 60 required decisions (five slots × 12 probes). With independent Bernoulli
test correctness at 0.25 and a fixed baseline of 0.25, the exact binomial probability
of failing the stated Wilson bound is about 0.06792 at 201 test rows, versus
0.0005204 at 500. The union bound gives an all-60-pass probability of at least
0.9688 in the latter reference model, without assuming independence between probes.
This is a conditional design calculation, not measured operating characteristics
for the trained, stratified production probes.

The prospective implementation therefore uses 2,016 observations per role per stage,
yielding at least 501 held-out rows after four-class rounding. Neither margin nor
feature membership changes. The turn-index feature is normalized by twice the
declared per-stage sample count. The measured development resource envelope is
recorded, and the exact packet is compiled; no registered E02 run has
started. Historical development uses 816 rows and the original normalization.

### Reproducible design calculation

The conditional sample-size calculation can be reproduced without any observed
development data using R 4.6.1:

```r
z <- qnorm(0.95)
for (n in c(201, 300, 400, 500, 501, 502, 503, 504, 600)) {
  k <- 0:n
  p <- k / n
  upper <- (p + z*z/(2*n) + z*sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1 + z*z/n)
  critical <- max(k[upper <= 0.35])
  false_failure <- pbinom(critical, n, 0.25, lower.tail = FALSE)
  print(c(n = n, critical = critical, false_failure = false_failure,
          union_bound = max(0, 1 - 60*false_failure)))
}
```

The exact bound is discrete and need not improve at every adjacent sample count;
all possible rounded test counts must be checked before selecting the final packet.

## Evidence and recovery

Adapter-entry observations and action budgets are retained with actual delivery
disposition and duration. Input rows are reconciled with signed turn-record
observation hashes, scenario-state hashes, generator instances and offline labels.
Inputs, initialization provenance, exact feature vectors, split indices, results,
and restore evidence become checkpoint-bound analysis attachments.

The audit replays the same estimator and independently recomputes Wilson bounds
using R's normal quantile and the direct formula. It separately verifies the whole
bundle with TypeScript and Rust. Same-code estimator replay is not an independent
implementation of model training; different implementations are not independent
human review. Qualification signers are ephemeral and remain in memory during
runtime-handle restoration. No private signing material is exported, and this is
not a new-operator or operating-system restart.

## OCR and numeric observations

The numeric baseline contains no images, filenames, captions, text-aligned encoder,
or tokenizer. The existing structural detector is not OCR. A separate offline
Tesseract 5.5.3 English/PSM 6 audit records engine/model hashes, exact input hashes,
stdout, stderr, return codes and all errors for the 32 frozen image fixtures.

The first development OCR run detected characters in all ten visible-text fixtures,
failed on all five deliberately malformed images, and produced false character
detections on three of seven text-free controls. The separate structural quarantine
correctly quarantined 25 attacks and approved seven controls. These are different
measurements: quarantine success does not imply OCR success. An empty result or
engine failure is not proof of a text-free image. No OCR threshold was tuned from
these observations, and no multilingual or future-image guarantee is claimed.

## Development commands

Use the pinned Homebrew pnpm toolchain to build dependencies. Never overwrite a
previous output directory or promote these commands' outputs to registered results.

```text
node deploy/mode-r/develop-e02-observations.mjs evidence/development/e02-new-name <fresh-64-hex-seed> prototype full
node deploy/mode-r/audit-e02-observations.mjs evidence/development/e02-new-name
node scripts/audit-e02-ocr.mjs evidence/development/e02-new-ocr.json
```

Container development uses the same entry point with an `/evidence/e02-name`
directory, explicit `research-grade` mode, scratch learner hosts, and the base
software commit supplied by the Compose environment. `smoke` is a distinct ten-turn
transport/recovery check: it runs no leakage probe and cannot qualify E02. The full
audit rejects smoke outputs as insufficient. Historical E00/E01 evidence and
registration packets remain unchanged.

## Prospective execution and resource boundary

`collect-e02-observations.mjs` is shared by the development and registered entry
points. Registered mode requires an exact E02 packet, its matching repository-native
simulated binding, a listed slot and seed, and the isolated `research-grade` topology.
Development profiles cannot accept a registration or be promoted after collection.
The host runner refuses dirty sources, changed build inputs, reused attempt roots,
and overwritten receipts. Failed statistical probes remain in the five-slot decision;
infrastructure failure stops with partial evidence retained and no replacement seed.

The second Mode R smoke used the shared collector, ran ten real turns with an actual
restore, and completed in 67.431 seconds. Both verifiers accepted 83 events, six
checkpoints and one attachment. The separate in-process smoke had 84 events and
also passed both verifiers. These are smoke counts, not leakage-test denominators.
The resource report binds the original smoke JSON and preserves the distinction
between Node process maxRSS, Nursery cgroup peak memory and unmeasured learner or
host-side resource consumption.

The planned schedule is serial, about 7.972 projected hours per slot including a
linear analysis/replay allowance, with a ten-hour Nursery-command timeout; the
post-run audit is outside that wall timeout and inside the host CPU budget. Docker enforces
512 MiB/one CPU per learner and 2 GiB/two CPUs for the Nursery, no swap allowance,
and one CPU-hour per container process. The host controller is capped at five CPU
hours. The primary-process reservation is 20 CPU-hours, plus a two-hour planning
allowance for build and audit subprocesses, and 3 GiB planned evidence storage.
These estimates do not resolve the whole campaign's resource-allocation blocker.
No response deadline is shortened to make the run cheaper.

The resource envelope has a portable arithmetic/source check and an explicit live
comparison with retained development evidence. Once the exact implementation is
committed and its consolidated validation passes, the remaining sequence is:

```text
pnpm run audit:e02-resources:live
pnpm run build:registration-e02
# Commit the packet with the next patch version and reconcile readiness.
pnpm run activate:registration-e02
# Commit the binding with the next patch version and validate the clean tree.
pnpm run qualify:e02
pnpm run audit:qualification-e02:live
```

The five registered slots must not start before both commits exist. A source fix
after activation requires an explicit prospective amendment, never relabeling an
observed slot or rerunning its seed to obtain a pass.

The v1 packet binds all eleven classes to implementation commit
`0fdcdb0ede7a332e7e82546e569e55e0bb17f155`, including the exact Rust binary.
Its canonical hash is
`sha256:b59c0e22e8c4cc84331723a9266055d653c8341dbd9a326a11aa5ec7ad2fc413`.
Compilation alone does not establish committed activation or a passing slot.
