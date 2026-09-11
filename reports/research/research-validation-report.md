# The System Is Software-Qualified, but the Research Questions Remain Open

Working research-validation report  
Evidence cutoff: 2026-09-11  
Latest qualified component candidate: `39a6e45` / v0.1.55
Report status: in progress  

## Executive Summary

- The project has a substantial and freshly exercised software foundation. The exact
  v0.1.50 candidate passed 1,760 tests in 139 files, the secret scan, the
  high-severity dependency audit, and every consolidated static/build gate from a
  detached worktree after a frozen Homebrew pnpm install.
- An independent Rust implementation agrees with the production verifier on a fresh
  signed export and rejects six deliberate integrity attacks. A 114-test focused
  mutation/recovery run also passed on the exact implementation commit.
- The exact v0.1.48 Mode R topology passed four bounded full-lifecycle runs. Scratch
  RL and self-supervision used independently initialized, capacity-matched
  4,049-parameter GRU models, updated both roles, and retained constant exported
  policy hashes throughout evaluation. The independent Rust auditor accepted all
  four bundles. This is software evidence, not a public-chain or research result.
- The exact v0.1.50 carrier candidate executed all five E13 carrier conditions through
  the production runtime. The three generative conditions began with disjoint private
  banks, acquired and deterministically modified partner forms without expanding
  model capacity, later emitted both origins, froze during evaluation, and passed
  both production and separate Rust verification. This is mechanism qualification,
  not E13 evidence.
- The exact v0.1.52 frozen-model candidate used Homebrew llama.cpp 0.4.0 and the
  hash-matched Qwen3-4B Q4_K_M asset. Both dedicated role processes passed live
  server probes, clean-process replay, all four tool-only calls, and the distinction
  between changing private memory and an absent weight-update path. Its serialized
  topology and 300-second qualification ceiling are not production-capacity evidence.
- The exact v0.1.55 control-lifecycle candidate exported and production-verified
  seven bounded runs spanning trained/frozen evaluation, a derived disabled-channel
  control, no-learning, deadline forfeits, manual abort, evaluation safety escalation,
  and SQLite snapshot restart. The independent Rust auditor accepted all 365 events
  and 52 checkpoints after its own lineage-normalization defect was exposed and fixed.
- This does not answer the research questions. The experiment notebook still marks
  all 19 experiments `Not started`; the only retained behavioral corpus contains
  33 Prototype Mode qualification runs and is unregistered, unanchored, and invalid
  for confirmatory inference by construction.
- The current host can support software validation and bounded CPU pilots and now
  retains the verified 4B model asset, but has no qualified accelerator and cannot
  hold two inference processes concurrently. The perceptual carrier generalization,
  confirmatory, and replication paths require further implementation, measured
  pilot costs, and authentic external approvals.
- The defensible publication position today is a protocol and software-readiness
  draft, not a completed empirical paper. This report will be extended only from
  verified artifacts; null, failed, invalid, and blocked outcomes remain visible.

## 1. Scope and evidence classes

This report asks whether the repository, protocols, execution environment, data,
analyses, and manuscript support a complete research contribution on grounded,
auditable communication between independently adapting agents. It separates four
classes that must not be collapsed:

| Evidence class | Meaning | Present status |
|---|---|---|
| Inspected repository fact | A file, commit, configuration, or implementation property was directly inspected | Available, with requirement-level audit still in progress |
| Software qualification | A bounded executable path or failure condition was exercised | Consolidated checks pass through v0.1.55; exact recurrent, full Mode R, generative-carrier, frozen-model, control-lifecycle, and independent bundle audits pass at their recorded candidates |
| Pilot evidence | Data collected to test feasibility or freeze design choices, excluded from confirmatory inference | No newly classified pilot corpus yet |
| Confirmatory or replication result | Data collected under authentic prospective registration, matching pre-run anchor, approved governance, and frozen analysis | None |

The evidence cutoff is a versioned snapshot, not a claim that later changes inherit
its results. Full file and execution provenance will be added to the data/claim
manifest as each plan stage closes.

## 2. Research premise and lineage

The governing premise is stable: two independently adapting agents interact with
a shared environment through a deterministic, controlled channel and may develop an
external protocol. Private observations, memory, learning state, and native ledgers
remain separate. Capability restrictions replace age simulation; pretrained frozen
models test external protocol use rather than first-language acquisition. Affect is
bounded and audited. Learned encodings are research objects, not security controls.

The detailed [source-lineage register](source-lineage-register.md) maps these
requirements to the repository commits where they first appear and to later
normative refinements. The map identifies a material boundary: implementation and
readiness work after the original protocols does not convert earlier qualification
runs into experimental evidence.

## 3. Current corpus

The historical qualification store contains 28,776 files totaling 280,373,166 bytes
and 33 exported run directories: five seeds each for six E03-style conditions and
three E11-style runs. Its SQLite database hash is
`sha256:2f349a0b417fb74432b7b12bd6b7c92db4e89941d547a381e1007af006b40185`.
The corpus is useful for verifier, export, report, and pipeline checks. It is not a
pilot or confirmatory dataset because every run uses the Prototype Mode,
unregistered, unanchored invalid path.

A replacement two-episode frozen-model qualification binds a locally retained,
read-only weight file and the resolved Homebrew inference executable by independently
computed SHA-256. Its live probes and server logs are now locally reproducible. Two
episodes still cannot establish convergence, generalization, or model comparison.

## 4. Environment and reproducibility baseline

The machine-readable [environment manifest](environment-manifest.json) records the
host, point-in-time resources, tool versions and binary hashes, Homebrew bootstrap,
container base digest, local evidence inventory, and asset limitations without any
credential or secret value.

The validation host has six logical x86-64 CPUs, 8,086,106,112 bytes of memory, no
swap, and 198,498,086,912 bytes of filesystem capacity available at capture. The
active tools are Homebrew 6.0.22, Homebrew Node 24.20.0, Homebrew pnpm 12.3.4,
Homebrew actionlint 1.7.12, Homebrew llama.cpp 0.4.0, pre-existing Rust 1.94.0,
and pre-existing Docker 29.7.2 with Compose 2.29.7. No GPU capability is asserted.

The pnpm migration preserved directly resolved external dependency versions where
they remained compatible, pins lifecycle-build permissions to exact versions or a
commit-pinned source archive, and makes workspace dependencies explicit. The document
renderer required `@napi-rs/canvas` 1.0.9 and `pdfjs-dist` 6.3.289 after the preserved
1.0.8/6.2.108 pair failed against the Homebrew Node 24.20 build; this scoped change is
recorded as a compatibility repair rather than silent dependency drift.
The first validation run exposed a denied pnpm ESM link in the learner-host permission
boundary. A later Mode R run exposed an undeclared verifier dependency that npm had
previously hoisted. Both failures were retained in ignored evidence storage, fixed at
their cause, and followed by clean passing executions.

## 5. Fresh software-validation results

| Check | Result | Scope and limit |
|---|---:|---|
| Frozen-lockfile install | Pass | 25 workspace projects from a newly created pnpm `node_modules` in a detached exact-commit worktree; dependency installation, not scientific reproducibility |
| Workflow syntax | Pass | `actionlint` 1.7.12 on the consolidated workflow |
| Consolidated check | Pass | 135 test files, 1,739 tests, source/contract/boundary/readiness/status/API checks, build, secret scan, and dependency audit |
| Recurrent candidate check | Pass | Exact v0.1.48 detached candidate: 137 test files, 1,750 tests, Rust tests/clippy, every consolidated gate, secret scan, and dependency audit |
| Generative-carrier candidate check | Pass | Exact v0.1.50 detached candidate: 139 test files, 1,760 tests, Rust tests/clippy, every consolidated gate, secret scan, dependency audit, five production carrier runs, and five separate Rust bundle audits |
| Control-lifecycle candidate check | Pass | v0.1.55: 140 test files, 1,765 tests, three Rust tests plus clippy, every consolidated gate, 616-file secret scan, dependency audit, seven production-verifier passes, and seven separate Rust bundle audits |
| Dependency audit | Pass | No known advisories at the configured high threshold; does not prove absence of vulnerabilities |
| Mode R smoke | Pass | Two distinct containers, denied direct routes/filesystem/clipboard/process/worker access, normalized timing/size/error checks, 12 attack categories, kill-survival, and local updates for three reference tracks |

The consolidated pass consumed 134.76 seconds wall time and peaked at 988,776 KiB
resident memory on the recorded host. The passing Mode R command consumed 89.33
seconds wall time and peaked at 56,448 KiB in the host process; Docker build and
container resource use are not fully represented by that host-process maximum.

The machine-readable [software-validation receipt](software-validation-receipt.json)
binds these results to commit `ca7a188b1b4dabceece0172d300bd9b167bff042`,
records command exit states and measurements, and publishes hashes for the ignored
raw logs and tracked-file manifest. The detached worktree remained clean after the
run. Because this report and receipt are later documentation, they are not part of
the candidate that was exercised.

These results establish bounded software behavior on one host and candidate. Later
V07–V10 receipts qualify the recurrent learners, generative-carrier learning,
locally served frozen-model path, and study control lifecycle. Public-chain execution
and a frozen same-commit candidate containing every later research mechanism remain open.

## 6. Independent integrity challenge

The [integrity challenge receipt](integrity-challenge-receipt.json) binds a second
qualification stage to exact commit `745f9ab774abd3b4c52b668548060e2d82a8837c`.
Its production TypeScript verifier and separately implemented Rust auditor both
accepted a fresh exporter-produced bundle containing 50 events, four checkpoints,
a confirmed local fixture receipt, and a bound analysis attachment. Both rejected
each of six mutations: changed event content, changed attachment bytes, injected
lineage, network/chain disagreement, false receipt calldata, and a validly signed
unanchored event tail.

A focused ten-file suite passed 114 tests, including the full verifier mutation
matrix, attachment and cross-binding attacks, 20 randomized kill/recovery trials,
fork preservation, and terminal recovery. The first detached focused invocation
failed before testing because it omitted the documented build prerequisite and its
child process could not resolve generated package entry points. The preserved
failure led to an explicit build-before-test command; it is not counted as a flaky
test or hidden by the passing rerun.

Revalidating the 33 retained historical qualification exports produced a negative
compatibility result: both current verifiers reject all 33 because their old run
manifests omit the now-required `intervention` tree name. The 79,263 events and 1,156
checkpoints were not rewritten. This uniform format drift is not evidence of later
tampering, but the old exports cannot be described as passing the current bundle
contract. They remain useful as preserved legacy qualification material only.

## 7. Full Mode R topology qualification

The machine-readable [Mode R topology receipt](mode-r-topology-receipt.json) binds
four bounded runs to exact commit
`97a33bec8966343afff3eebd2be331434b2872ad`. A detached checkout remained clean
after a frozen pnpm install and after execution. Each of `no-learning`,
`scratch-rl`, `self-supervised`, and `hybrid` used distinct learner containers and
completed four training plus four evaluation turns through the real controller,
Gateway, SQLite Evidence Writer, checkpoint service, exporter, and production
verifier. All four sealed, all verifier exit codes were zero, and the corpus contains
295 primary events, 49 checkpoints, and four local qualification receipts.

The independent Rust auditor separately accepted all four exports, rechecking 299
events when intervention entries are included, every checkpoint, and each local
receipt binding. The run consumed 525.17 seconds wall time and the observed host
process peaked at 55,424 KiB; those memory figures exclude Docker daemon, image-build,
and container consumption.

The signer path now refuses direct secret-bearing environment values and plaintext
key directories. Public-study signer material must enter as a mode-0600 regular,
non-symlink file materialized by `si fort`, with exact run authorization. Compose
rendering and tests verify that only the Nursery receives the file mount and that
neither learner receives its path or contents. No authorized Fort runtime session
was available, so the persistent path was checked with non-secret fixtures rather
than real credentials.

The anchor transport was an explicitly labeled local fake chain. Therefore this
qualification demonstrates orchestration and evidence integrity only: it is not a
public-chain transaction, prospective registration, pilot outcome, or empirical
finding.

## 8. Matched recurrent-baseline qualification

The [recurrent-baseline receipt](recurrent-baseline-receipt.json) binds V07 to exact
commit `6871f8df8780eb3b54bb5d18d766e9164831ccfd` / v0.1.48. The candidate implements
one deterministic 16-unit GRU with sender, receiver, and value heads, independently
seeded Xavier initialization, separate Adam state per learner, four PPO-style epochs,
a 0.2 clip, one-step truncated recurrence, value coefficient 0.5, and gradient-norm
cap 1. The reward-free comparison instantiates the same complete 4,049-parameter
core and substitutes partner-message predictive cross-entropy for actor/value loss.
The count and tabular implementations remain explicitly named reference controls.

A central-difference check on the largest sampled predictive-gradient component had
relative error `4.43e-12`. The optimizer-isolation check updated one independently
constructed model without changing the other. A bounded reward-free toy mapping
increased mean target probability from 0.3128 to 0.5042. These are regression and
numerical qualification results, not estimates of communication learning.

The exact detached candidate passed all 1,750 tests and the complete consolidated
check. In Mode R, the recurrent scratch and self-supervised runs each used distinct
learner containers, updated both policies, produced 13 witnessed checkpoints, held
the final two policy checkpoint hashes equal across learning-disabled evaluation,
sealed, and passed the production verifier. Together with no-learning and hybrid
topology witnesses, the independent Rust audit accepted 297 events including
interventions and 49 checkpoints. The raw 2,335-file, 6,001,123-byte evidence tree is
ignored by Git and content-bound in the receipt.

The first post-documentation consolidated attempt failed because the 300-turn E11
integration test retained a legacy 60-second override and exceeded it under
full-suite contention. The test was not shortened or skipped; the override was
removed so it inherits the repository's 180-second integration budget, after which
the full suite and exact replay passed. The failed attempt is retained in the receipt.

The container build also exposed a separate supply-chain concern: a commit-pinned
document-renderer source runs its own nested npm install and printed two high-severity
build-dependency advisories. The top-level pnpm audit reported no known vulnerabilities,
but that does not erase the nested warning; removing or isolating that build-time path
is now a V11 concern.

This qualification does not start E11 or E12. It does not show above-chance held-out
communication, convergence, causal listening, or equality of optimization difficulty
or compute. The locked model and limits are documented in the
[recurrent baseline qualification](../../docs/recurrent-baseline-qualification.md).

## 9. Generative-carrier learning qualification

The [generative-carrier receipt](generative-carrier-learning-receipt.json)
binds V08 to exact commit
`886dd53eddc5b4b42f89305ffd0e778f5a348c4a` / v0.1.50. The mechanism
retains a fixed learner action dimension while allowing training updates to
replace bank slots with an exact Gateway-delivered partner artifact and a
deterministic, parent-linked local variant. Novel observations are staged by
`receive` but enter checkpointed state only through `updatePolicy`, so retry
and evaluation observations do not mutate the exported policy. Scratch-policy
checkpoint versions now serialize and strictly validate the carrier, ordered
slots, complete artifacts, hashes, origins, introduction turns, parent links,
and next replacement position while accepting prior policy versions.

The exact candidate passed all 1,760 tests in 139 files and every consolidated
gate from a clean detached worktree after a frozen install. Five production
Prototype Mode runs—fixed token, fixed glyph, bitmap, canvas, and tone—each
completed 40 training and 12 evaluation turns. All 260 turns were accepted by
the selected real Gateway module. In each of the three generative conditions,
the roles' initial eight-form banks had zero hashes in common; both final banks
contained four acquired and four modified forms, and both roles later emitted
forms of both origins. The runs contained 186 repeated delivered artifacts and
held their exported policy hashes constant throughout evaluation.

All five production verifier reports had exit code zero. The separate Rust
auditor also accepted all five bundles, independently checking 1,828 events
including interventions and 171 checkpoints with no reported issue. The
27,910,867-byte raw evidence tree is ignored by Git and content-bound by a
15,700-file manifest in the receipt.

Capacity accounting reports the physical grammar separately from the fixed
learner bank. At eight selectable forms, effective capacity is 3 bits per
one-mark message in every condition. The bitmap grammar permits 256 physical
bits; the eight-stroke canvas grammar has about 140.680 bits; and the up-to-eight
tone grammar has about 40.046 bits. Those larger figures are not reported as
model capacity.

This qualification closes the executable acquisition, exact imitation,
bounded modification, chronology, recovery, and capacity-accounting gap. It
does not establish perceptual generalization, learned transformation rules,
useful convention formation, or a carrier effect. The runs are unregistered,
unanchored software qualifications with invalid research dispositions, and E13
remains not started. The mechanism and its boundary are documented in
[generative carrier learning](../../docs/generative-carrier-learning.md).

## 10. Frozen-model runtime qualification

The [frozen-model qualification receipt](frozen-model-qualification-receipt.json)
binds the version-2 report to exact commit
`d6d98dfb4826d3c86d4dcc35e2e93edf53e4591e`. The official 2,497,280,256-byte
Qwen3-4B Q4_K_M GGUF matches SHA-256
`7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5`.
The Homebrew llama.cpp 0.4.0 server reports build `b10809-5266f24da`; its resolved
executable and x86_64 bottle match the independently recorded hashes in the receipt.

Each role ran through a dedicated, non-overlapping process on a distinct loopback
endpoint with one 4,096-token slot. The operator disabled prompt caching and model
thinking, required tool calls, used greedy temperature zero with per-turn seeds, and
set a 192-token output cap plus a 300-second qualification budget. Live `/health`,
`/props`, `/v1/models`, and `/slots` probes cross-checked the loaded alias, Q4_K
medium file type, model dimensions, runtime build, context, slot count, tool-capable
chat template, and modality flags. Both roles produced identical hashed tool-only
responses before and after clean process restarts.

The two-episode adapter run made four live model calls and all four passed the
tool-only learner boundary. Both roles sent and received, and each role's two policy
snapshot hashes differed because private episodic memory changed. The adapter exposed
no `updatePolicy` method, both role clients retained the same exact weight description,
and the runner rehashed the read-only weights and executable after execution. Thus
“frozen” is evidenced as an immutable weight asset and absent weight-update path; it
does not mean private memory is static.

Failure history materially shaped the result. A first probe exposed a missing
thinking-disable request. A concurrent two-process attempt exceeded this host's
7.5-GiB/no-swap capacity and lost one process. A serialized attempt exceeded the old
114-second model ceiling, and a 64-token cap ended one receiver completion before a
valid tool call. Those failures are retained as diagnostics; the passing run uses the
historical 192-token cap and an explicit 300-second software-qualification ceiling.
The serialized result does not establish concurrent deployment capacity or the normal
study deadline. The executable/bottle hashes also do not enumerate every dynamic
system library. Finally, the zero-of-two descriptive task success is not a scientific
estimate, and the run is neither registered nor anchored.

## 11. Study-control lifecycle qualification

The [study-control lifecycle receipt](study-control-lifecycle-receipt.json) binds V10
to exact commit `39a6e4570b9593d3305d979a19412bee4f104094` / v0.1.55. A clean launch
executed seven exported runs through the production SQLite writer, checkpoint service,
local qualification anchor, exporter, and verifier. All seven production reports had
exit code zero. The separate Rust auditor accepted all seven bundles, independently
checking 365 events and 52 checkpoints with no issue.

The trained parent changed both scratch policies over 16 training turns and held both
hashes constant for four evaluation turns. Its evaluation schedule was frozen before
evaluation and two causal probes were applied. A derived child loaded both immutable
parent policy artifacts, recorded matching pre-initialization source hashes, used a
disabled channel throughout four evaluation turns, froze both policies during that
phase, and produced no lineage verifier gap. The no-learning run exposed no
`updatePolicy` method on either role, emitted no policy-checkpoint event, and retained
constant policy hashes.

Two deliberately over-budget turns each produced a Gateway timeout rejection and a
recorded forfeited turn. A manual abort after one turn produced an `aborted-sealed`
bundle and aborted experiment disposition. A fault on the first evaluation turn was
retried exactly once, wrote one adapter-failure trigger, escalated because pause is
unavailable in evaluation, and stopped after the failed turn with a verified
`aborted-sealed` bundle. A scratch run was snapshotted at turn four, its SQLite store
closed and reopened, and automatic recovery matched the turn cursor, both policy
hashes, and every committed stream prefix before completing ten turns and sealing.

The first exact candidate is an informative negative result: its production verifier
accepted the derived bundle, but the independent Rust auditor rejected it because the
auditor expected initial-policy references at the wrong configuration location. The
auditor was corrected to normalize `babyA.initialPolicyRef` and
`babyB.initialPolicyRef`, given a focused regression, and the entire consolidated
suite rerun before the clean v0.1.55 qualification. The failed audit is not included
in the seven-pass result.

The exact run consumed 10.05 seconds and peaked at 195,940 KiB resident memory. Its
3,108-file, 5,949,655-byte ignored evidence tree is content-bound in the receipt. These
runs are unregistered software fixtures on a local fake chain. They do not estimate a
communication effect, production model latency, public anchoring, or independent-host
restore; the disabled child also contains one training turn before frozen evaluation.

## 12. Critical gaps before empirical claims

1. Generative learners now acquire exact partner artifacts and expose bounded local
   variants, but perceptual similarity, learned transformation, held-out form
   generalization, and useful sign invention remain unimplemented or untested.
2. The existing E03 sufficient-statistic simulator does not yet validate the complete
   gate under bounded episode generation, multiplicity, dependence, tails, invalid
   runs, and reserve use.
3. The runner now qualifies a derived trained-policy disabled-channel evaluation, but
   a prospectively registered, seed-paired panel of normal, disabled, constant, random,
   and shuffled controls is still needed to estimate causal communication effects.
4. Leakage measurements need explicit allowed and forbidden information sets plus
   detectable positive controls before a negative bound is meaningful.
5. Ledger-prediction value must be compared with transcript-only, policy-state, random,
   majority, and oracle baselines without circular access to the target policy.
6. Frozen-model functionality and serialized role-state isolation are now qualified,
   but concurrent capacity and the normal study latency budget are not; those require
   a larger execution host and the actual study topology.
7. The bounded full topology and recurrent models are qualified, but real chain
   receipts, external registration, governance, independent restore, and independent
   replication records do not exist.

## 13. Current scientific and publication conclusion

The repository supports continued engineering and protocol work. It does not support
an abstract or conclusion claiming emergent communication, compositionality, causal
listening, affect-channel benefit, negotiation, encoding security, or replication.
The current defensible contribution is an auditable research protocol and substantial
software infrastructure with bounded qualification evidence. Whether that becomes a
competitive empirical contribution depends on completing the registered studies and
showing an insight beyond systems integration.

The provisional [requirement-level conformance matrix](../../docs/requirement-conformance-matrix.md)
now inventories every backlog criterion and normative MUST-bearing source line with
concrete executable surfaces and required receipts. Subsequent revisions will add
remaining behavioral dispositions through V11, the verified literature register, protocol cards, pilot cost model,
run/data manifest, analyses, audit-cost comparison, claim map, and critical review.
