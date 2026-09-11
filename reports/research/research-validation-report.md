# The System Is Software-Qualified, but the Research Questions Remain Open

Working research-validation report  
Evidence cutoff: 2026-09-11  
Latest tracked research-design candidate: v0.1.69 (D08 and A03 in progress; A01 snapshot complete)
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
- The integrated v0.1.56 candidate passed a clean detached frozen install, all 1,765
  tests and consolidated gates, the four-track real-container topology, the seven-run
  control replay, and 11 independent Rust bundle audits on one immutable commit. A
  nested document-renderer build stage retains two known high-severity dev-toolchain
  advisories, so no hardened supply-chain claim is made.
- The bounded source audit and novelty challenge are complete, and all 19 experiments
  now have frozen question/estimand/outcome-class cards. H2 tests a causal receiver
  effect; H4 separately tests held-out ledger prediction beyond non-ledger baselines.
- The numeric referential design now has an executable 12-type train/validation and
  four-type compositional test partition. A real leakage defect that exposed test
  types as training distractors was corrected, and model comparisons now declare
  matched budgets plus causal-versus-descriptive interpretation boundaries.
- Independent base-R validation now agrees with 28 production numerical values and
  quantifies interval coverage, TOST boundary error, clustering, invalid runs, the
  complete E03 numeric gate, and nine-member Holm sensitivity. It exposed and removed
  an uncalibrated E03 tail-count rejection before registration.
- The causal-ledger and leakage protocol now freezes prospective prediction
  commitments, validation-only comparator selection, exact information sets, and
  detector-positive controls. E02 and E20 use powered one-sided negative bounds;
  intended carrier form is no longer mislabeled as a side channel.
- Exact v0.1.68 synthetic qualification exercised all five eligible E16 non-ledger
  predictors, disjoint validation selection, prospective commitments, seven negative
  controls, and the oracle-selection prohibition. Production intervention-chain
  integration remains open, so this is not an E16 result.
- The v0.1.62 D06 candidate passed all 1,771 tests across 140 files, the Rust
  auditor tests and clippy, every consolidated static/design gate, a 641-file secret
  scan, and the high-severity dependency audit. The live base-R leakage-design replay
  was byte-identical to the frozen receipt.
- The seed/resource design derives 27,190 collision-free values across disjoint
  qualification, pilot, confirmatory, and replication domains and caps tuning at five
  development iterations. A fresh five-run benchmark supplies measured CPU, memory,
  time, byte, and file rates rather than an assumed cost model.
- An internal adversarial readiness review covers every experiment and returns
  `not-registration-ready`. Fourteen evidence-linked blockers include governance,
  anchors/registration, resources, pilot-selected N, final detector/comparator
  qualification, exact packets, independent review, and citation re-review.
- The complete local data/claim snapshot resolves and hash-binds 111 exported bundles
  in 16 collections. All are excluded from empirical estimates; 63 local fake-chain
  confirmations are separately labeled from zero confirmed public-chain anchors.
- The frozen local audit-cost benchmark covers five immutable qualifications: 260
  turns, 1,828 stream events, a 687,916-byte ordinary-log proxy, 2,053,633 bytes of
  actual signed streams, and 20,650,214 verifier-input bytes. Both implementations
  account for 12/12 prior mutation challenges; public-anchor cost remains unmeasured.
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

## 3. Current corpus and claim inventory

The [data/claim inventory](../../docs/data-and-claim-inventory.md) captures every
exported bundle present in ignored local evidence storage at the cutoff: 111 bundles,
16 collections, and 219,742,662 bundle bytes. It records content-tree, manifest, and
verification-report hashes without copying raw events or private ledger content.
Thirty-six bundles have tracked exact/current bounded software-qualification support,
33 are historical qualification exports, and 42 are failed or superseded diagnostic
artifacts. Every one is excluded from pilot, confirmatory, replication, and empirical
hypothesis estimates.

All 111 have a recorded verifier exit code of zero. The 33 historical exports remain
incompatible with the current intervention-tree declaration and do not inherit later
verifier status. Sixty-three reports record anchor confirmation, but those receipts
are local fake-chain qualification evidence. Confirmed public-chain anchors: zero.
This distinction is machine-enforced so an anchor flag cannot silently become a
public-chain claim.

The historical qualification subset contains 33 exported run directories: five seeds
each for six E03-style conditions and three E11-style runs. Its SQLite database hash
is `sha256:2f349a0b417fb74432b7b12bd6b7c92db4e89941d547a381e1007af006b40185`.
It remains useful for verifier, export, report, and pipeline checks but is not a pilot
or confirmatory dataset.

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

## 12. Integrated software candidate

The [integrated candidate receipt](integrated-software-candidate-receipt.json) binds
V11 to detached exact commit `b2b119c9469bdc452dbdfab4dabd70337b0ba837` /
v0.1.56. The worktree was clean before and after a frozen pnpm install, after the
consolidated check, and after container execution. The exact suite passed 1,765 tests
in 140 files, three Rust tests plus clippy, every static/readiness/status/API gate, a
617-file secret scan, and the configured high-severity dependency audit in 164.15
seconds with 938,296 KiB peak resident memory.

On that same commit, four distinct-learner-container Mode R tracks completed 32 turns,
261 primary events, and 49 checkpoints. Every run sealed and production-verified;
the recurrent scratch and self-supervised tracks retained matched 4,049-parameter
capacity, independent initialization, observed training updates, and frozen evaluation
hashes. The seven-bundle control lifecycle replay also passed. A freshly rebuilt Rust
auditor accepted all 11 exports, independently checking 662 events and 101 checkpoints.
The retained 4B model and Homebrew inference executable hashes also remained unchanged.

The image build reproduced two known high-severity advisories inside the commit-pinned
document renderer's nested dev lock: `pdfjs-dist` 6.1.200 and `sharp` 0.35.3. The root
workspace uses fixed versions 6.3.289 and 0.35.4, and exact scans found neither
vulnerable nested version in any of the three pruned runtime images. This narrows the
risk to the source-prepare build stage; it does not eliminate it. V11 is therefore
closed with an explicit claim reduction: runtime integration is qualified, while
hardened or vulnerability-free image construction is not claimed.

The exact candidate used local qualification anchors and ephemeral qualification
signers. It does not supply a public-chain receipt, authentic registration, governance
approval, independent-host restoration, or scientific outcome. The frozen-model and
five-carrier live component runs were not repeated because their implementations did
not change after their exact receipts; their assets and integrated tests were rechecked.

## 13. Literature audit and novelty challenge

The [source verification register](source-verification-register.md) closes the
bounded internal D01 audit. All 50 existing locators resolved to identifiable
records; each now has a machine-readable publication classification, inspection
depth, exact permitted support, limitation, and inclusion decision. Nine
load-bearing sources and one disputed supporting source were inspected in full. The
audit corrected [26]'s pagination from 116–143 to 116–140 and removed an unsupported
claim that [15] supplied causal symbol-intervention evidence. The register also
records exact update queries, five 2024–2026 comparators, screening rules, and the
single-screener/non-systematic limitation.

The [novelty comparator matrix](novelty-comparator-matrix.md) closes the internal
D02 challenge for protocol design. Mature prior work separately covers modular
emergent-communication toolkits, causal listening, learned sketches and continuous
signal spaces, pretrained-model alternative formats, cross-partner coordination,
reproducible machine-learning workflows, and append-only transparency mechanisms.
Consequently the report rejects every first/only/unique formulation.

The surviving candidate contribution is an incremental-value question: whether
outcome-blind contemporaneous private semantic ledgers add predictive and audit value
beyond transcripts, task outcomes, policy-state readouts, ordinary logs, and signed
logs when evaluated with causal interventions and independently verifiable run
provenance. This is not a finding. It becomes a supportable contribution only if the
registered comparisons succeed and the manuscript-freeze search plus independent
citation review do not reveal a closer integrated comparator.

## 14. Frozen research questions and estimands

The [research protocol cards](../../docs/research-protocol-cards.md) freeze one
machine-checkable card for every E00–E50 experiment. Each card identifies its
independent unit, exposure, comparator, primary outcome, estimand, evidence class,
secondary outcomes, exploratory outcomes, dependencies, and the later design package
that must fill its remaining operational parameters. The notebook still reports all
experiments as not started.

The design removes a prior H2/H4 overlap. H2 is the causal within-case change in
receiver probability assigned to the ledger-predicted action under a
ledger-consistent substitution versus a shuffled valid message, holding receiver
observation and policy state fixed. H4 is the held-out improvement in a proper
prediction score over the strongest validation-selected eligible non-ledger baseline.
The same agreement statistic cannot satisfy both.

The confirmatory family has nine members: H1, H2, H3, H4, H5, H6a, H6b, H7, and H8.
One preregistered p-value is formed per member and Holm correction is applied globally
at family-wise alpha 0.05. Multi-component directional hypotheses use the maximum
component p-value and require every direction and practical threshold. E00–E03 and
experiment-specific integrity checks are validity gates rather than alpha-bearing
hypotheses; missing or failed gates produce `not-tested`.

This closes D03 at the question/estimand level. It does not complete D05–D08, choose
all statistical thresholds, supply power, authorize collection, or create a result.

## 15. Locked scenario splits and model-comparison boundaries

The [scenario and comparison design](../../docs/scenario-splits-and-model-comparisons.md)
freezes the current numeric referential space before outcome collection. Of the 16
two-attribute semantic types, 12 non-diagonal types support training and
in-distribution validation; the four diagonal combinations are held out as test
targets. Every attribute value occurs in both partitions. Training and validation
have independent PRNG domains, learning is disabled during validation, and no
held-out type may occur in either split as a target or distractor. The held-out test
is accessed once after tuning and baseline selection freeze. The pre-existing
`evaluation` split remains qualification-only.

This audit exposed and corrected a substantive leak: the engine previously excluded
held-out types as training targets but could still sample them as distractors, making
the supposedly unseen combinations visible to a learner. An executable design audit
now generates 2,000 instances from each of train, validation, and held-out, rejects
cross-split instance duplication, verifies candidate-level exclusion, and requires
coverage of every held-out target type.

The same manifest classifies recurrent learning-mechanism, bandwidth, carrier,
affect, partner-training, and incentive contrasts as within-architecture causal only
when their declared budget dimensions match. Comparisons between pretrained and
recurrent or otherwise different architectures are descriptive because pretraining,
scale, tokenizer, memory, runtime, and optimization cannot be isolated by merely
matching task episodes. For E30, equal total exposure intentionally produces one
eighth of the per-partner exposure in the eight-partner arm, so both quantities must
be reported.

This closes D04 for the numeric generator and declared model comparisons. It does
not determine sample sizes, statistical operating characteristics, resource ceilings,
or asset near-duplicate thresholds and does not create an experimental result.

## 16. Independent statistical validation and power

Homebrew R 4.6.1 supplied an implementation independent of the TypeScript analysis
package. The frozen 66-row receipt checks distribution functions, one-sample and
Welch tests, TOST, Holm, Wilson, exact-binomial, quantile, entropy, mutual information,
and a beta-binomial fit; all 28 production references
agree within `1e-10`. Every simulation proportion includes its two-sided 95% Wilson
Monte Carlo interval.

The validation confirmed approximately nominal Wilson and seed-t coverage. A
999-resample percentile bootstrap at N=25 instead covered 0.9335 of bounded
beta-binomial draws, with 95% Monte Carlo interval [0.9217, 0.9436]. Bootstrap output
therefore remains a sensitivity estimate. Under seed clustering, pooled episode
inference had estimated Type I error 0.3081 while the seed-level test had 0.0406,
empirically confirming that episodes cannot be treated as independent.

The audit also found that the former E03 requirement limiting high-rate seeds to 5%
was incompatible with its own variance design. Its full-rule power was 0.0705 in the
lowest-variance row and zero observed passes in the other 10,000-repetition rows.
The prospective amendment retains every rate at or above 0.35 as a mandatory
case-level leakage review but does not treat the count as a statistical test. The
complete bounded numeric rule now has estimated power 0.9318, 0.9308, 0.9163, and
0.9552 across the four registered variance rows; every lower 95% Monte Carlo bound
exceeds 0.90.

Global Holm is not free. For nine independent one-sided members with standardized
effect 0.40, the probability all nine reject was 0.6752 at N=75 and 0.9068 at N=100.
Those values do not set a universal sample size. D07 must use each hypothesis's
frozen raw-scale practical margin and disjoint pilot variance, simulate its complete
test including composite outcomes and missingness, and select the largest count whose
lower Monte Carlo power bound reaches 0.90. Full methods and limitations are in the
[statistical validation note](../../docs/statistical-validation-and-power.md).

This closes D05's method validation. It does not substitute design simulations for
observed evidence and does not finalize D07's hypothesis-specific allocation.

## 17. Prospective causal-ledger and leakage validation

The versioned [causal-ledger and leakage protocol](../../docs/causal-ledger-and-leakage-protocol.md)
separates H2's paired behavioral intervention effect from H4's held-out incremental
prediction value. Training ends and policies freeze before the ordered probe schedule,
prediction-function version, native predictions, selected comparator, and comparator
predictions are committed and checkpointed. Comparator selection uses validation data
only. Test outcomes are then generated once. Uniform, validation-majority,
transcript-only, task-history, and policy-state information sets are explicit; the
oracle is detector-positive and forbidden from selection.

The same protocol enumerates allowed and forbidden information for E01, E02, E13,
and E20. It corrects two method defects before collection. First, an observed probe
accuracy inside a shuffled-label interval is only a calibration diagnostic: E02 now
requires at least 200 untouched test rows, a one-sided 95% Wilson upper advantage
bound no greater than 0.10, and successful detection of an injected target feature.
Second, structural variation in a permitted carrier is the message itself. Its
referent mutual information is now a form-use/bandwidth diagnostic rather than a
leakage failure; metadata, timing, envelopes, undeclared media properties, and
recognizable priors remain prohibited.

E20 now refuses a study-level decision below 75 eligible seeds and uses a seed-level
Student-t upper bound as its primary 0.02-bit gate. The under-covering percentile
bootstrap remains visible as sensitivity. Independent base-R calculations show E02
chance clearance 0.9157 and boundary false clearance 0.0426 at 200 test rows. Under
E20's explicit normal seed-statistic and SD <= 0.04-bit design assumption, zero-excess
clearance is 0.9959, boundary Type I error is 0.05, and a 0.04-bit positive control is
detected with probability above 0.99999999. A blinded pilot must verify the variance
assumption or D07 must increase N. These are operating characteristics, not outcomes.

The E16 comparator core is now exact-commit qualified separately. Five eligible
predictors fit on 40 validation-fit cases, were compared on a disjoint 20-case
validation-selection fold, and the planted task-history signal was selected and
refit. Twelve outcome-free test inputs were prediction-committed before the scoring
API accepted labels. Seven negative controls rejected fold overlap, outcome-bearing
test input, undeclared information, extra native-prediction fields, selection and
prediction tampering, and invalid probability vectors. The zero-Brier native
prediction was deliberately built from fixture labels and is only a scoring positive
control. This proves deterministic plumbing, not historical outcome blindness;
production intervention-chain evidence is still required.

## 18. Disjoint allocation and resource feasibility

The [seed and resource allocation](../../docs/seed-and-resource-allocation.md) freezes
NUL-separated SHA-256 domains for software qualification, blinded pilots,
confirmatory execution, and replication. Paired conditions share a scenario seed at
the same experiment/slot while each condition, role, Gateway, and analysis stream is
distinct. The generated audit derived 27,190 seed values without collision. Pilot
outcomes may choose only the primary N and fixed ten-percent reserve prefix; they
cannot tune models, outcomes, margins, directions, splits, or exclusions.

The candidate grid is N=25, 50, 75, 100, 125, 150, 200, and 300. Each hypothesis's
frozen raw margin and blinded-pilot upper variance bound must drive 30,000 complete
family simulations. The smallest shared N whose lower 95% Monte Carlo power bound is
at least 0.90 is selected. N=100 is only the provisional resource value supported by
the existing standardized-effect-0.40 family simulation. If N=300 is insufficient,
the affected study remains unregistered rather than widening its margin.

A fresh five-carrier/260-turn qualification took 37.58 wall seconds at about one CPU,
peaked at 264,896 KiB RSS, and wrote 25,532,466 bytes across 15,695 files. Scaling the
maximum seed pools at this recurrent-run rate yields 9,171 bundles, 9,358,100 turns,
855.9 GiB uncompressed, and 375.7 single-core hours. Frozen-model and public-chain
costs are not included and can only raise requirements. The authorized local ceiling
is 72 CPU-hours, 25 GiB, 6 GiB process memory, one frozen-model process, and zero
external spend. Local qualification and bounded pilots fit; the complete campaign
does not. This is a measured feasibility finding, not an empirical research result.

The first consolidated D07 run failed one synthetic transport-timing assertion after
1,770 other tests passed because its no-op fixture used the contended host wall clock.
The harness already exposed an injectable monotonic clock, so the test now uses that
deterministic boundary. The focused suite passed 20 consecutive executions and the
complete gate then passed all 1,771 tests across 140 files. This stabilizes the test
without relaxing the real transport evaluator or its tolerances.

## 19. Local audit cost and integrity utility

The [audit cost and utility note](../../docs/audit-cost-and-utility.md) binds five
immutable, research-excluded E13 qualifications to a versioned benchmark protocol.
Across 260 turns and 1,828 stream events, the payload-only lower bound is 546,418
bytes and the declared ordinary JSONL proxy is 687,916 bytes. Actual signed streams
occupy 2,053,633 bytes, 2.985 times the proxy. Complete verifier inputs occupy
20,650,214 bytes, 30.019 times the proxy.

The full ratio is not cryptographic overhead. Integrity structures account for
12,117,263 bytes, including 11,795,564 bytes of individual proof files and 309,373
bytes of checkpoints. Policy snapshots account for another 6,437,525 bytes. The
small-run checkpoint frequency and individual-proof layout make these ratios highly
design-dependent.

With process startup included, per-bundle median production-verifier latency ranges
from 982.747 to 1,156.726 ms. The independent Rust auditor ranges from 39.159 to
49.963 ms, while a whole-input SHA-256 ranges from 48.964 to 53.950 ms. These are not
equivalent operations: the production verifier checked 15,391 exported proof files;
the Rust auditor covered the same 1,828 events and 171 checkpoints but does not check
those exported proof files; hashing supplies only byte-change detection relative to
a trusted digest. Timings are uncontrolled-cache, single-host descriptions.

The receipt binds the already-prespecified mutation challenge. Both verifier
implementations accepted the unchanged fixture and rejected event-content,
attachment-byte, lineage, wrong-chain, false-receipt, and unanchored-tail mutations:
12 observed rejections across 12 implementation-by-case checks. One fixture per case
is deterministic conformance evidence, not a sensitivity estimate.

A03 remains in progress. No RPC was supplied, zero public transactions occurred, and
public anchor latency and fee are null rather than estimated. Registered study-scale
ordinary/signed/full comparisons must also wait for eligible pilot and confirmatory
bundles.

## 20. Critical gaps before empirical claims

The internal [methods readiness review](methods-readiness-review.md) covers all 19
experiment cards and identifies 14 blockers with explicit closure tests. It does not
claim independent review. No experiment is registration-ready, and the fail-closed
machine audit rejects any ready flag while the recorded campaign decision is negative.

1. Generative learners now acquire exact partner artifacts and expose bounded local
   variants, but perceptual similarity, learned transformation, held-out form
   generalization, and useful sign invention remain unimplemented or untested.
2. Hypothesis-specific blinded-pilot variances and resulting selected N prefixes remain
   to be produced before D08 can freeze registration-ready configurations.
3. The runner now qualifies a derived trained-policy disabled-channel evaluation, but
   a prospectively registered, seed-paired panel of normal, disabled, constant, random,
   and shuffled controls is still needed to estimate causal communication effects.
4. The E01 timing/envelope detectors and E13 forbidden-side-feature detectors must be
   exercised in the actual selected topology before their negative claims are eligible.
5. Causal-ledger comparator implementations and registered practical effect margins
   now have exact synthetically qualified validation-only selection and prospective
   scoring code, but production integration and prospective execution remain required;
   this qualification does not supply outcomes.
6. Frozen-model functionality and serialized role-state isolation are now qualified,
   but concurrent capacity and the normal study latency budget are not; those require
   a larger execution host and the actual study topology.
7. The bounded full topology and recurrent models are qualified, but real chain
   receipts, external registration, governance, independent restore, and independent
   replication records do not exist.

## 21. Current scientific and publication conclusion

The repository supports continued engineering and protocol work. It does not support
an abstract or conclusion claiming emergent communication, compositionality, causal
listening, affect-channel benefit, negotiation, encoding security, or replication.
The current defensible contribution is an auditable research protocol and substantial
software infrastructure with bounded qualification evidence. Whether that becomes a
competitive empirical contribution depends on completing the registered studies and
showing an insight beyond systems integration.

The provisional [requirement-level conformance matrix](../../docs/requirement-conformance-matrix.md)
now inventories every backlog criterion and normative MUST-bearing source line with
concrete executable surfaces and required receipts. The software candidate and
bounded literature/novelty audit, question/estimand cards, and numeric split/model
comparison design, independent statistical validation, prospective causal-ledger and
leakage protocol, and local audit-cost benchmark are complete. Subsequent revisions
will add the registration-ready run/data manifest, empirical analyses, public-anchor
and registered study-scale portions of the audit-cost comparison, claim map, and
critical review.
