# Phase-One Evidence Appendix

This appendix supports the September 4–13 phase-one update. It distinguishes
tracked summaries from ignored raw evidence and distinguishes verification from
experiment execution.

## Evidence classes

| Class | Meaning in this repository |
|---|---|
| Implemented | Code or documentation exists; no pass is implied |
| Tested or software-qualified | A named finite check passed on a bound candidate |
| Development observation | Useful diagnostic excluded from registered estimates |
| Failed or incomplete attempt | Attempted evidence is retained; no missing stage is inferred |
| Planned, not executed | Protocol or software may exist, but the experiment did not run |
| Unverified or external | Evidence requires another reviewer, system, or trust boundary |

## Claim-to-evidence map

| Claim used in the update | Bound commit or cutoff | Tracked evidence | Raw evidence | Verification command | Boundary |
|---|---|---|---|---|---|
| The inherited baseline already contained the research design and pre-results manuscript | `feb6870` | Git tree and history | Not required | `git show --stat feb6870` | Repository provenance does not establish idea authorship |
| The integrated software candidate passed its bound clean-checkout qualification | `b2b119c` / v0.1.56 | `research/integrated-software-candidate-receipt.json` | Required only for a live bundle replay | Inspect the receipt; `pnpm run check` separately validates the current source tree | Historical pass is not a current full rerun or research result |
| E00 passed its five-slot integrity suite | `6a3faa8` | `research/e00-integrity-qualification-receipt.json` | Ignored bundles needed for `:live` comparison | `pnpm run audit:qualification-e00`; add `:live` on the execution host | Software integrity qualification only; simulated commitment |
| E01 v2 passed five slots with 560 signed records | `4ba1f27` | `research/e01-v2-qualification-receipt.json` | Ignored slot records and bundles needed for live comparison | `pnpm run audit:qualification-e01`; add `:live` on the execution host | Finite registered corpus, not 560 attacks and not a behavioral result |
| E02 v1 failed before restore and analysis | `895d59a` | `research/e02-qualification-receipt.json` | `evidence/qualification/e02-v1/` contains the attempt, partial database, bundle, slot summary, and log | Inspect the receipt; the passing-only E02 auditor must fail on this incomplete attempt | 465 turns and 930 delivered observations; zero completed probes; four slots unattempted |
| The frozen data inventory contains 138 bundles and zero research-included bundles | v0.1.104 cutoff | `research/data-claim-manifest.json` | Needed to rebuild or extend the inventory | `pnpm run audit:data-claims`; add `:live` for a whole-tree comparison | Predates the partial E02 attempt |
| The current manuscript is pre-results | Current tracked manuscript and readiness audit | `RESEARCH.md`, `research/manuscript-readiness-audit.json` | Not required for the tracked consistency check | `pnpm run audit:manuscript-readiness` | No empirical result or independent review |

Paths in the table are relative to this `reports/` directory unless shown at the
repository root.

## E02 failure accounting

The terminal receipt has `passed: false`, an empty `slots` array, and a non-null
failure. The slot summary and database provide the diagnostic detail:

- 465 committed turn records, numbered 0–464;
- 930 delivered adapter-entry observations;
- 351 accepted and 223 rejected Gateway channel events;
- all 223 rejections classified as response timeouts;
- a signed `max-consecutive-rejections` safety intervention at turn 464;
- no restore record, no completed leakage report, and no container resource summary;
- slots 2–5 not attempted.

The historical slot summary says `probeEvaluation: "executed"`; this is contradicted
by its empty report list and absent restore record. The original file remains intact
as evidence. Future collectors derive the value from completed reports and would
record this state as `not-reached`.

## Clean-checkout versus retained-evidence checks

These commands operate from tracked files and are suitable for a normal checkout:

```bash
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run lint:project-status
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:campaign-readiness
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:qualification-e00
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:qualification-e01
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:manuscript-readiness
```

The corresponding `:live` commands compare ignored raw records and must run only on
a host that retains the referenced `evidence/` tree. A missing raw tree is an
unavailable check, not a failed historical qualification.

`pnpm run audit:qualification-e02:live` is a passing-qualification auditor. It is
expected to reject the retained incomplete v1 attempt and must not be used to erase
or reinterpret that failure.

## Presentation exclusions

This package contains no screenshots or exported private evidence. Consequently,
there are no image credentials, personal paths, or visual success indicators to
review. Any later screenshot or export must be checked for secrets, private paths,
mode labels, run disposition, and readable claim boundaries before it is shared.
