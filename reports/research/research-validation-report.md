# The System Is Software-Qualified, but the Research Questions Remain Open

Working research-validation report  
Evidence cutoff: 2026-09-11  
Latest qualified component candidate: `97a33be` / v0.1.46
Report status: in progress  

## Executive Summary

- The project has a substantial and freshly exercised software foundation. A clean
  Homebrew/pnpm environment passed 1,735 tests in 134 files, the secret scan, the
  high-severity dependency audit, workflow lint, and the real-container Mode R
  smoke suite after two package-layout defects were reproduced and fixed.
- An independent Rust implementation agrees with the production verifier on a fresh
  signed export and rejects six deliberate integrity attacks. A 114-test focused
  mutation/recovery run also passed on the exact implementation commit.
- The exact v0.1.46 Mode R topology passed four bounded full-lifecycle runs through
  distinct learner containers, the controller, Gateway, SQLite writer, checkpoint
  service, local qualification anchor, exporter, production verifier, and independent
  Rust auditor. This is software evidence, not a public-chain or research result.
- This does not answer the research questions. The experiment notebook still marks
  all 19 experiments `Not started`; the only retained behavioral corpus contains
  33 Prototype Mode qualification runs and is unregistered, unanchored, and invalid
  for confirmatory inference by construction.
- The current host can support software validation and bounded CPU pilots, but no
  accelerator or local model weights were found in the recorded scan. The full
  recurrent, generative-carrier, confirmatory, and replication program therefore
  requires implementation, measured pilot costs, and authentic external approvals.
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
| Software qualification | A bounded executable path or failure condition was exercised | Consolidated checks pass at v0.1.46; the exact v0.1.46 full Mode R topology and independent bundle audit pass |
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

A separate two-episode frozen-model report binds reported model/runtime identifiers
and hashes. The corresponding model weights and inference executable were not found
under the bounded local asset scan, so local independent reproduction is presently
impossible. Two episodes cannot establish convergence, generalization, or model
comparison in any case.

## 4. Environment and reproducibility baseline

The machine-readable [environment manifest](environment-manifest.json) records the
host, point-in-time resources, tool versions and binary hashes, Homebrew bootstrap,
container base digest, local evidence inventory, and asset limitations without any
credential or secret value.

The validation host has six logical x86-64 CPUs, 8,086,106,112 bytes of memory, no
swap, and 198,498,086,912 bytes of filesystem capacity available at capture. The
active tools are Homebrew 6.0.22, Homebrew Node 24.20.0, Homebrew pnpm 12.3.4,
Homebrew actionlint 1.7.12, pre-existing Rust 1.94.0, and pre-existing Docker 29.7.2
with Compose 2.29.7. No GPU capability is asserted.

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

These results establish bounded software behavior on one host and candidate. They do
not yet satisfy the recurrent scientific learners, frozen-model reattestation,
public-chain execution, or a frozen same-commit qualification candidate that contains
every later research mechanism.

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

## 8. Critical gaps before empirical claims

1. The scratch learner is tabular rather than the recurrent baseline required for
   the principal scientific comparison; the reward-free learner is also tabular.
2. Generative carriers begin from fixed private inventories and do not yet establish
   partner-form acquisition, modification, perceptual generalization, or invention.
3. The existing E03 sufficient-statistic simulator does not yet validate the complete
   gate under bounded episode generation, multiplicity, dependence, tails, invalid
   runs, and reserve use.
4. Existing no-learning message controls share identical paired trajectories because
   the receiver ignores messages. A fixed trained receiver under controlled messages
   is needed for causal communication qualification.
5. Leakage measurements need explicit allowed and forbidden information sets plus
   detectable positive controls before a negative bound is meaningful.
6. Ledger-prediction value must be compared with transcript-only, policy-state, random,
   majority, and oracle baselines without circular access to the target policy.
7. The bounded full topology is qualified, but real chain receipts, external
   registration, governance, independent restore, and independent replication
   records do not exist.

## 9. Current scientific and publication conclusion

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
behavioral dispositions from V04–V11, the verified literature register, protocol cards, pilot cost model,
run/data manifest, analyses, audit-cost comparison, claim map, and critical review.
