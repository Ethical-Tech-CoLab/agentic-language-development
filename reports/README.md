# Reports

## `reports/research/`

The living research-validation report, its source-lineage register, and its
machine-readable environment manifest. These artifacts distinguish inspected
repository facts, freshly executed software qualification, planned empirical
work, and externally blocked prerequisites. They are not experiment results.

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
adapter against the public Qwen3-4B Q4_K_M weights served by the official
llama.cpp b10870 Linux x64 release. It records the exact SHA-256 hashes of both
the weight file and runtime archive, the software commit exercised, bounded
event counts, and policy hashes. It intentionally omits prompts, observations,
raw model output, candidate references, and private ledger content.

This report proves only that a real open-weight model completed both Baby roles
through the tool-only learner boundary. Its two-episode descriptive success
rate is not a behavioral result and must not be cited as one.

Regenerate it against a loopback server with:

```sh
pnpm run qualify:frozen-model \
  --endpoint http://127.0.0.1:18080 \
  --model ../Qwen3-4B-Q4_K_M.gguf \
  --weights /absolute/path/Qwen3-4B-Q4_K_M.gguf \
  --quantization Q4_K_M \
  --runtime-id llama.cpp-b10870-linux-x64 \
  --runtime-artifact-hash sha256:<64-hex-digit-runtime-archive-digest> \
  --episodes 2 \
  --out reports/qualification/frozen-model-qwen3-4b-q4-k-m.json
```

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
