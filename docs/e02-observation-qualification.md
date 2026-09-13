# E02 observation qualification: implementation and evidence boundary

Status: registered v1 and v2 attempts both failed before restore and probe
evaluation. V1 exposed the nested deadline race; v2 corrected that race but exposed
an uncovered post-action timeout path after 161 recorded turns. E02 is not qualified.
The v2 packet and its fresh seeds are consumed and must not be reused.
The current candidate implements one audited timeout-forfeit path for every adapter
method used during a turn. It makes a timed-out remote adapter unreachable, pauses
the attempt immediately, and refuses resume—including after runtime recovery—so a
late host completion cannot affect another turn. The five-rejection pause remains
the ceiling for non-remote timeout rejections. Local synthetic and real framed-
adapter deadline fixtures pass. Exact v0.1.115 also passed the full repository and
ordinary two-container Mode R gates, with source and logs bound in the
[v3 readiness qualification](../reports/research/e02-v3-readiness-qualification.md).
The v3 packet is repository-registered under
`sha256:d35e6b118e4c811f80b426680a0b2f4b0c9b8da3e59bdc56293e557ef979f248`.
Its five identifiers and seeds are disjoint from v1/v2. A matching deterministic
simulated commitment records three confirmations and zero currency. The seeds remain
unused. Exact v0.1.119 passed the full 1,963-test gate, release-auditor hash check,
and ordinary two-container Mode R preflight. The
[execution-gate receipt](../reports/research/e02-v3-execution-gate.md) authorizes one
sequential v3 attempt.

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
recorded. The registered five-slot execution was attempted; historical development
uses 816 rows and the original normalization.

### Registered v1 attempt disposition

The attempt started from exact clean commit `895d59a90b66cf74603d58f1962c58f98e29dfb9`.
Slot 1 retained 465 turn records and 930 delivered adapter-entry observations. At
turns 460–464, five consecutive learner response timeouts triggered the configured
safety pause. The next turn was correctly refused because a paused run does not
accept turns. No snapshot/restore or leakage probe report was produced, and slots
2–5 were never attempted.

The terminal receipt is tracked; the partial database, bundle, and log remain under
ignored evidence storage. The raw slot summary's historical `probeEvaluation` value
said `executed`, but its empty `reports` array and absent restore record establish
that evaluation was not reached. Future summaries derive that field from completed
reports. The failed seed set remains consumed.

The timing boundary was reproduced without study seeds. The prior Mode R proxy
padded turn-path calls to the 1,000 ms normalization deadline while the Nursery
independently raced the same call against that boundary. The correction makes the
trusted normalized adapter the single deadline authority through remote work,
parsing, policy synchronization, and fixed-schedule release. The Nursery retains
its deadline for adapters without that authority. Genuine late completion and the
five-rejection safety pause remain enforced. A new prospective packet, binding, run
identifiers, and seed root are still required before another registered attempt.

### Registered v2 attempt disposition

The attempt started from exact clean commit
`7ed10f9f844f6a51c257f1f57829a57bbdf754ab`. Slot 1 retained 161 turn records,
324 delivered observations, 162 accepted channel events, and one checkpoint. One
deadline exceedance and one dropped response occurred after both turn-161
observations, the accepted sender event, receiver interpretation, and receiver
action-side ledger writes, but before the turn record. No safety event, restore,
probe report, sealing, or final export completed; slots 2–5 were not attempted.

The original error did not persist the exact method. The recorded ordering localizes
it to the post-action turn path. The wrapper receipt's zero slot summaries result
from a later assertion against the failed slot, not from absence of the partial
evidence. The current correction routes `observe`, sender and receiver `act`,
`receive`, and `onOutcome` deadline failures through one audited forfeit path,
records the method and role, and preserves the five-consecutive-rejection pause.
Remote framed-adapter fixtures additionally show immediate boundary quarantine and
no-resume recovery for each method. Exact v0.1.115 passed those cases within the
1,959-test repository gate and separately passed the ordinary two-container Mode R
lifecycle. The receipt discloses that delayed-method injection was framed in-process,
not injected inside a container. These checks permit prospective v3 registration;
they do not qualify E02 itself.

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

The committed-candidate Mode R smoke used the shared collector, ran ten real turns
with an actual restore, and completed in 71.221 seconds. Both verifiers accepted its
bundle. The two adapters reported zero timeouts and zero protocol violations; the
SQLite channel record contains no timeout reason code. The separate in-process
smoke also passed both verifiers. These are smoke observations, not leakage-test
denominators. The resource report binds the committed-candidate JSON and preserves
the distinction between Node process maxRSS, Nursery cgroup peak memory and
unmeasured learner or host-side resource consumption.

The planned schedule is serial, about 8.397 projected hours per slot including a
linear analysis/replay allowance, with a ten-hour Nursery-command timeout; the
post-run audit is outside that wall timeout and inside the host CPU budget. Docker enforces
512 MiB/one CPU per learner and 2 GiB/two CPUs for the Nursery, no swap allowance,
and one CPU-hour per container process. The host controller is capped at five CPU
hours. The primary-process reservation is 20 CPU-hours, plus a two-hour planning
allowance for build and audit subprocesses, and 3 GiB planned evidence storage.
These estimates do not resolve the whole campaign's resource-allocation blocker.
No response deadline is shortened to make the run cheaper.

The resource envelope has a portable arithmetic/source check and an explicit live
comparison with retained development evidence. The v2 sequence is:

```text
pnpm run audit:e02-resources:live
pnpm run build:registration-e02
# Commit the packet with the next patch version and reconcile readiness.
pnpm run activate:registration-e02
# Commit the binding with the next patch version and validate the clean tree.
pnpm run qualify:e02
pnpm run audit:qualification-e02:live
```

The same sequence is no longer executable for v1 because the attempt consumed its
seed set and failed. V2 uses new paths, identifiers, and seeds and preserves v1; no
observed slot is relabeled or rerun to obtain a pass.

The v1 packet binds all eleven classes to implementation commit
`0fdcdb0ede7a332e7e82546e569e55e0bb17f155`, including the exact Rust binary.
Its canonical hash is
`sha256:b59c0e22e8c4cc84331723a9266055d653c8341dbd9a326a11aa5ec7ad2fc413`.
Compilation alone does not establish committed activation or a passing slot.

The packet commit is `4d7068b5ccc1c8259239923d88ebff10fb85a3b1`. The matching
repository-native binding records a successful local simulated commitment, not
a public transaction. Execution may begin only from a clean descendant containing
the committed binding and after the full consolidated suite passes.

The prospective v2 packet is committed at
`f1f63b4607d1b68033f7d8934e56b0b6559dde2b` with canonical hash
`sha256:3d925374d7fd309ddcbb694def69c3bb7d3dd1f93a6742070f84fa32d0a9189d`.
Its matching binding records a confirmed deterministic simulation at block 1 and
transaction-shaped identifier
`0x041e98a23a16d0eb1de9481fe81361d1a66863a71b4ba350df4c06996c53ee69`.
This is prospective local ordering evidence only: no public transaction, public
timestamp, real funds, or external custody is claimed.

## Registered v1 execution record

The original attempt started at 2026-09-13 14:16:52 UTC on clean execution commit
`895d59a90b66cf74603d58f1962c58f98e29dfb9`. That exact commit passed 1,933 tests,
Rust tests/clippy, a 747-file secret scan and the complete consolidated suite.
The first slot recorded 465 turns before the safety pause and then terminated. This
is a failed qualification attempt, not a behavioral result.

The bounded user service `ald-e02-qualification-v1.service` has no automatic
restart, a 55-hour outer runtime limit and a five-minute cleanup allowance.
Its controller was designed to run and audit the five slots serially and wrote the
terminal receipt to `reports/research/e02-qualification-receipt.json`. Individual evidence
and logs remain under `evidence/qualification/e02-v1`. The user manager is
session-bound; it is now stopped with exit status 1. Never restart this attempt into
the same reserved seed set.

Read-only monitoring:

```text
systemctl --user status ald-e02-qualification-v1.service
journalctl --user -u ald-e02-qualification-v1.service --no-pager -n 30
```
