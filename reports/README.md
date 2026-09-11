# Reports

## `reports/research/`

The living research-validation report, source-lineage register, source-verification
register, novelty-comparator matrix, research protocol cards, and machine-readable
environment manifest. The versioned scenario/comparison manifest and its readable
design note freeze the numeric compositional split, leak checks, matched budgets, and
causal-versus-descriptive interpretation boundaries. The statistical-validation
receipt is independently generated with base R and covers numerical reference values,
coverage, boundary error, clustering, complete E03 power, global-Holm sensitivity,
and invalid-run behavior. The causal-ledger/leakage protocol freezes prospective
prediction chronology, comparator information sets, allowed/forbidden fields,
detector-positive controls, and powered E02/E20 negative bounds; its base-R receipt
contains outcome-blind operating characteristics rather than experiment results.
These artifacts distinguish inspected repository facts, freshly executed software
qualification, planned empirical work, and externally blocked prerequisites. The
literature register records evidence depth and permitted source use; the comparator
matrix explicitly prohibits unsupported priority claims. They are not experiment
results.

## `reports/qualification/`

Output of `scripts/run-qualification.mjs` (BACKLOG ALD-072): one directory
per run set, named `<YYYYMMDD-HHmm>-<short git sha>` by default (or whatever
`--out` was given). Each directory holds:

- `REPORT.md` — the human-readable qualification report: the verbatim
  SPECIFICATION.md Prototype Mode claim-boundary statement, the verbatim
  qualification-run label, run parameters, the E03 chance-baseline analysis
  (RESEARCH.md Appendix D) and/or the E11 naming-game readout, a "what this
  shows / does not show" section, and a per-run appendix.
- `e03-summary.json` / `e11-summary.json` — the same data as canonical JSON
  (RFC 8785), present when that experiment was run.

These reports are the output of a **non-confirmatory software-qualification
run**: Prototype Mode, not pre-registered, no Base anchor submitted, every
run's Experiment Record disposition is `invalid` by construction
(SPECIFICATION.md §7.2). Nothing under `reports/qualification/` is a
research finding — see `QUALIFICATION_LABEL` in
`packages/orchestrator/src/experiments/e03-controls.ts`, quoted verbatim in
every generated `REPORT.md`.

Report directories are small (JSON and Markdown only) and are not
gitignored; the underlying evidence is.

## Real frozen-model software qualification

[`frozen-model-qwen3-4b-q4-k-m.json`](qualification/frozen-model-qwen3-4b-q4-k-m.json)
is a privacy-minimized, non-confirmatory qualification of the frozen-LLM
adapter against the public Qwen3-4B Q4_K_M weights served by a Homebrew-managed
llama.cpp runtime. The runner hashes the local weights and resolved executable,
cross-checks the Homebrew bottle, probes the live model/context/slot/template
metadata, gives each role a dedicated non-overlapping process and endpoint,
and checks deterministic responses across clean process restarts. It also
records actual request settings, live tool-call counts, changing private-memory
hashes, and the structural absence of a weight-update path. It intentionally
omits prompts, observations, raw model output, candidate references, and private
ledger content.

This report proves only that a real open-weight model completed both Baby roles
through the tool-only learner boundary. Its two-episode descriptive success
rate is not a behavioral result and must not be cited as one.

## Study-control lifecycle software qualification

[`study-control-lifecycle-receipt.json`](research/study-control-lifecycle-receipt.json)
binds the production-backed V10 qualification for frozen evaluation, a derived
disabled-channel control, no-learning, deadline forfeits, manual and automatic
abort paths, verified export, and SQLite snapshot restart. The receipt separates
the seven production-verifier and independent Rust-auditor passes from the failed
diagnostics that preceded them. These local fake-chain, in-process fixtures are
software evidence only; they are not registered experiment outcomes.

[`integrated-software-candidate-receipt.json`](research/integrated-software-candidate-receipt.json)
records the same-commit detached install, consolidated suite, real-container Mode R
run, control replay, independent Rust audits, asset hashes, and the explicit claim
reduction for the renderer's build-stage advisories.

The local weights file must be read-only. Regenerate the complete attested
qualification with the Homebrew `llama-server` on `PATH`:

```sh
pnpm run qualify:frozen-model \
  --model qwen3-4b-q4-k-m \
  --weights /absolute/path/Qwen3-4B-Q4_K_M.gguf \
  --quantization Q4_K_M \
  --context-length 4096 \
  --max-output-tokens 192 \
  --turn-response-budget-ms 300000 \
  --baby-a-port 19091 \
  --baby-b-port 19092 \
  --episodes 2 \
  --out reports/qualification/frozen-model-qwen3-4b-q4-k-m.json
```

On the six-CPU, 7.5-GiB, no-swap validation host, concurrent role processes
exceeded memory. Serialized dedicated processes therefore qualify isolation and
functionality, not concurrent deployment capacity or the normal study deadline.

## `evidence/qualification/`

The SQLite evidence database (`<runSetId>.sqlite`, plus SQLite's `-shm`/`-wal`
sidecar files) and the exported evidence bundles
(`<runSetId>/bundles/runs/<runId>/`) that back a qualification run's report.
This directory is **gitignored** — the repository's `/evidence/` and
`*.sqlite*` rules in `.gitignore` already cover it — because a qualification
run's raw evidence is large, regenerable from the same seeds
(`node scripts/run-qualification.mjs`), and, per the claim boundary above, not
itself a research artifact worth committing.

## Running a qualification pass

```sh
pnpm run build
node scripts/run-qualification.mjs
```

runs the default 5-seed E03 + 3-seed E11 pass and writes the report to
`reports/qualification/<runSetId>/`. See `node scripts/run-qualification.mjs --help`
for every flag (seed counts, episode/turn counts, `--skip-e03`/`--skip-e11`,
and overriding `--out`/`--db`/`--bundles`).

The script exits `1` if any produced evidence bundle fails independent
verification, printing which run(s) failed, so a non-zero exit from this
script (or from a CI job that runs it) means an evidence-integrity problem,
not merely an unqualifying statistical result.

## Design observations from qualification runs

- **E03 controls collapse with a no-learning receiver.** RESEARCH.md Appendix D fixes the
  same scenario seed for every condition at a given slot, and a `no-learning` receiver
  ignores the delivered artifact by construction. The `disabled`, `constant`, `random`,
  `shuffled`, and `normal-no-learning` trajectories at a slot are therefore identical, so
  the five equivalence tests in the report are not independent evidence. The controls
  become informative only when the receiver policy can respond to messages (for example a
  trained `scratch-rl` policy evaluated under the control conditions, or a
  pre-registered per-condition receiver seed). This is a property of the registered
  design, not a defect in the harness, and is recorded here for the researchers who own
  EXPERIMENT-NOTEBOOK.md.
