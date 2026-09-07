# Reports

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
npm run build
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
