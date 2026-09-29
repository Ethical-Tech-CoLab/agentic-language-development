# First-paper manuscript package (R11) — skeleton

Status: **skeleton only, pre-results**. Prepared 2026-09-27 under R11 of the
master validation plan. Corrected 2026-09-27 (HANDYM h1h2-manuscript): the
earlier "R03–R10 are unimplemented" blanket is withdrawn — R03 design packets
are frozen (lineage commit `9be6e536` + R03-B F1/F2 `9c25643` + seed-vocab `f4cc224`; see `first-paper-draft.md` §5.1), the R01
attempt inventory is committed (`e6d5da0`), the R02 development diagnosis is
complete, and R04/R05 implementation commits are in history; R06–R10
(qualification, pilot, lock, main, repeat) are unrun. Every results-bearing
field in this package is `TBD` until populated from verified, sealed evidence.
No numeric result, interval, or cost figure in this package is an observation.

- Research authority: the frozen R03 design packets (lineage `9be6e536` + R03-B F1/F2 `9c25643` + seed-vocab `f4cc224` — see §5.1),
  tracked `protocols/` files, and sealed stage evidence — never `plans/`.
  `plans/` is gitignored work coordination (R00–R15 queue, R11 notes); it is
  not a registration and not evidence, so nothing here cites it as authority.
- Scope summary: `first-paper-draft.md` §§1–5. Venue gate:
  `review-package.md` §C4 (TMLR, conditional target) — a coordination
  note only; current official TMLR pages govern at freeze.
- This package is planning/reporting scaffolding. It does not create
  registrations, authorize collection, or assert that any empirical gate passed.

## Files

| File | Contents | Populates from |
|---|---|---|
| `first-paper-draft.md` | Markdown manuscript draft: question, population, information-access table, methods, results shells, limitations, skeptical-review responses | R03 (design), R09 (main results), R10 (reproduction/repeat) |
| `estimates-and-intervals.md` | LV-U/P/C/L estimates, intervals, baselines, training and control curves: table shells plus generation contracts | R09 fixed analysis output, R10 repeat |
| `run-accounting.md` | Allocation/attempt table, deviation log, failed-development accounting | R01 inventory, R05 terminal accounting, R07–R09 stage receipts |
| `artifact-outline.md` | Reproducible artifact outline: source identity, one reproduction entry point, input digests, verification steps | R05 CLI contracts, R10 reproduction receipt |
| `review-package.md` | Review skeleton: claim-to-evidence appendix, skeptical-review checklist, venue/source audit, release checklist | R09/R10 evidence, human review when available |

## Population rules (binding)

1. Fill a `TBD` only from verified results: sealed stage evidence, checked-in
   analysis output, or a tracked receipt. Never from estimates, projections, or
   development observations.
2. Results sections stay empty until R09 main analysis is sealed; repeat
   columns stay empty until R10. A study may finish with no supported
   improvement and still produce a correct report — do not rerun experiments to
   obtain a desired paper story.
3. Every populated number cites its evidence path and digest in
   `review-package.md` (claim-to-evidence appendix). Numbers without a cited
   source are removed, not footnoted.
4. Development, failed, and superseded records are accounting entries only
   (see `run-accounting.md`). They never supply empirical estimates, per the
   data/claim boundary in `docs/data-and-claim-inventory.md`.
5. No personal names in new prose. Disclose AI-assisted development and keep
   internal critique separate from human review.
6. Submission is a separate authorized action under current venue rules; local
   preparation never implies permission.

## Requirement traceability (handoff §9)

- Exact question, study population, information-access table, mode
  limitations → `first-paper-draft.md` §§1–3.
- Inherited foundation versus new work, with provenance →
  `first-paper-draft.md` §4.
- Complete allocation/attempt table and deviations, including failed
  development → `run-accounting.md`.
- Training curves, causal controls, LV-U/P/C/L estimates and intervals, all
  baselines → `estimates-and-intervals.md`.
- Equal-content predictive equality, mutation detection/false acceptance,
  actual capture/storage/query/verification cost; no
  signing-improves-semantics claim → `estimates-and-intervals.md`,
  `first-paper-draft.md` §6.
- Source/analysis identity and one reproduction entry point with exact input
  digests → `artifact-outline.md`.
- Repeat results, honest independence status, claim-to-evidence appendix →
  `estimates-and-intervals.md`, `review-package.md`.
- Skeptical review (trivial fidelity, weak comparators, temporal leakage,
  outcome selection, logical isolation, seed uncertainty, cost, external
  validity) → `first-paper-draft.md` §8, `review-package.md`.
