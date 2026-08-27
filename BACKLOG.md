# Agentic Language Development — Implementation Backlog

This backlog translates `SPECIFICATION.md`, `EXPERIMENT-NOTEBOOK.md`, and `LEDGER-INTEGRITY-DESIGN.md` into an implementation-grade, dependency-ordered plan. It is a derived planning artifact, not a normative source: where this document and the three source documents disagree, the source documents win and this backlog must be corrected.

## Table of Contents

1. [Document Status](#1-document-status)
2. [Planning Assumptions](#2-planning-assumptions)
3. [Priority Definitions](#3-priority-definitions)
4. [Sizing Scale](#4-sizing-scale)
5. [Workflow States](#5-workflow-states)
6. [Definition of Ready](#6-definition-of-ready)
7. [Definition of Done](#7-definition-of-done)
8. [Release and Milestone Roadmap](#8-release-and-milestone-roadmap)
9. [Epic Overview](#9-epic-overview)
10. [Dependency and Critical Path View](#10-dependency-and-critical-path-view)
11. [First 4 Iterations Execution Plan](#11-first-4-iterations-execution-plan)
12. [Backlog Items by Epic](#12-backlog-items-by-epic)
13. [Experiment Readiness Gate Mapping](#13-experiment-readiness-gate-mapping)
14. [Requirements Coverage Matrix](#14-requirements-coverage-matrix)
15. [Decisions and Assumptions](#15-decisions-and-assumptions)
16. [Appendix: ID Index](#16-appendix-id-index)

## 1. Document Status

- **Status:** Draft, ready for team review. No item in this backlog has been started; the repository is documentation-only and has no `package.json` or source tree.
- **Source of truth precedence:** `SPECIFICATION.md` governs implementation; `LEDGER-INTEGRITY-DESIGN.md` governs ledger, checkpoint, Merkle, and anchoring mechanics; `EXPERIMENT-NOTEBOOK.md` governs experiment pre-registration and results; `CONCEPT-IDEA.md` preserves research rationale. This backlog is derived from those documents and introduces no new normative requirements.
- **Scope of this backlog:** software and process engineering work required to stand up the system described in `SPECIFICATION.md` and to make every experiment in `EXPERIMENT-NOTEBOOK.md` §7–§8 executable. It does **not** include running the experiments themselves, interpreting results, or drafting findings — those are research-execution activities tracked in the notebook, not software backlog items.
- **Numbering:** Epics use stable IDs `EPIC-01`…`EPIC-15`. Individual backlog items use stable IDs `ALD-001`…`ALD-080`. IDs are assigned in dependency order: every item's `Depends on` list only ever references a **lower**-numbered ALD ID. IDs are permanent once assigned and must not be reused or renumbered by future edits; new work gets the next unused ID appended at the end of its epic's range or a new epic.

## 2. Planning Assumptions

- **Runtime and language:** Node.js with TypeScript, consistent with the DTSF ecosystem this project builds on. Package management is npm, using npm workspaces for a monorepo layout (no Yarn/pnpm).
- **Evidence store:** SQLite in WAL (write-ahead log) mode is the authoritative local evidence store, per `LEDGER-INTEGRITY-DESIGN.md` [§18. Recommended Initial Decision](LEDGER-INTEGRITY-DESIGN.md#18-recommended-initial-decision). No external database is introduced.
- **Anchoring chain:** Base Sepolia (testnet) is the first and default anchoring target. Mainnet anchoring is a separate, later, explicitly opt-in capability — never the default.
- **Model default:** `scratch-rl` is the primary scientific baseline. A local open-weight `frozen-llm` is the orchestration-validation default; `self-supervised` is the initial reward-free comparison. `no-learning` and `hybrid` are explicit controls/variants.
- **Isolation:** Research-Grade Mode (Mode R) runs learner processes in separate containers/processes with no shared mutable state beyond the Gateway and ledger, per `SPECIFICATION.md` [§5.2 Research-Grade Mode (Mode R)](SPECIFICATION.md#52-research-grade-mode-mode-r).
- **On-chain privacy:** no private, raw-observation, or model-internal data is ever placed in an on-chain anchoring payload — only checkpoint root hashes and minimal metadata, per `SPECIFICATION.md` [§13.6 Privacy Controls](SPECIFICATION.md#136-privacy-controls) and `LEDGER-INTEGRITY-DESIGN.md` [§12. Privacy](LEDGER-INTEGRITY-DESIGN.md#12-privacy).
- **No invented dates or staffing:** this backlog contains no calendar dates, durations, or headcount figures. Milestones are ordinal (`M0`…`M5`); the execution plan uses ordinal iterations (`Iteration 1`…`Iteration 4`, "Iteration 5+"). Sequencing is expressed purely through dependencies.
- **Repository today:** documentation-only. Every "implement X" item below is net-new work; none of it exists in the repository yet, so no item's acceptance criteria assume pre-existing code beyond what an earlier, lower-numbered ALD item established.
- **Diplomacy-table reuse:** the repository's existing UX components (e.g., from a prior Diplomacy-style project) may be reused only within the boundaries `SPECIFICATION.md` [§16.2](SPECIFICATION.md#162-diplomacy-table-reuse-boundaries) defines; this is treated as a constraint, not an invitation to reuse everything available.

## 3. Priority Definitions

Priority indicates *what breaks the claim boundary or blocks the critical path if delayed*, not simple business value. Priority is orthogonal to the MVP / Research-Grade / Later-Research classification used on each item (see §4 and item template in §12).

- **P0 — Safety, integrity, or critical path.** Evidence integrity (hashing, signing, atomicity, Merkle/checkpointing, verifier CLI), the run/turn state machine, integrity-fork detection/recovery, observation hygiene and isolation controls, Gateway core validation/rejection behavior, claim-boundary enforcement, and pre-registration binding. If a P0 item is wrong or missing, either the system can silently violate its own integrity claims, or no later work can proceed at all.
- **P1 — Core capability and research-grade readiness.** Model/learner adapters beyond the minimal path, Mode R isolation mechanics, telemetry/audit, the dashboard MVP, the mainnet anchoring *path* (not its activation), and documentation/operations. Required to run real studies credibly, but a delay does not corrupt evidence or silently break claims.
- **P2 — Advanced carriers, negotiation, cryptography research, or operational polish.** Generative-carrier and six-display-affect channels beyond the fixed-token baseline, cooperative-vs-negotiation scenario variants, the ephemeral-encoding/cryptography research harness, mainnet activation itself, and UX/console refinements. These extend research reach but are not required for the first credible, integrity-checked study.

A P0 item can still be classified `Later-Research` (e.g., the cryptographic novelty-vs-security separation policy is P0 because it protects the integrity system, but it is only operationally exercised once `E40` work begins).

## 4. Sizing Scale

Sizing is relative-complexity based, not calendar-based (no velocity or team-size baseline exists yet).

- **S (Small):** a single component, interface, or schema change, verifiable in isolation with a narrow test surface.
- **M (Medium):** one service/subsystem touching a small number of integration points (e.g., one schema plus its persistence and one consumer).
- **L (Large):** cross-service work or a new subsystem with multiple integration points and its own dedicated test surface (e.g., a new protocol channel, a new twin pack, a CLI tool).
- **XL:** reserved for **epics/themes only**. No individual `ALD-XXX` item is ever sized XL — if an epic-level theme is XL, it must be broken into S/M/L stories before work starts (this is exactly what §12 does for every epic in this backlog).

## 5. Workflow States

Every backlog item moves through: `Backlog` → `Ready` → `In Progress` → `In Review` → `Verification` → `Done`, with a `Blocked` side-state reachable from any non-`Done` state.

- **Backlog:** captured, not yet meeting the Definition of Ready.
- **Ready:** meets the Definition of Ready (§6); may be pulled into progress.
- **In Progress:** actively being implemented.
- **In Review:** implementation complete, undergoing code/design review.
- **Verification:** review passed; acceptance criteria being run (tests, conformance suites, gate checks, or — for security items — red-team execution).
- **Done:** meets the Definition of Done (§7).
- **Blocked:** cannot proceed; the blocking dependency or decision must be recorded on the item.

## 6. Definition of Ready

An item may enter `In Progress` only when:

- It cites at least one `SPECIFICATION.md` (or `LEDGER-INTEGRITY-DESIGN.md` / `EXPERIMENT-NOTEBOOK.md`) section as its normative source.
- Every item in its `Depends on` list is `Done`, or the dependency is explicitly waived in writing on the item with a stated reason.
- Its acceptance criteria are stated as testable, falsifiable statements (already true for every item in §12 as written).
- Priority, size, and classification (MVP / Research-Grade / Later-Research) are assigned.
- For any item touching evidence integrity, anchoring, or isolation (P0 safety-tagged items), the relevant source-document section has been re-read by the implementer in full, not skimmed.

## 7. Definition of Done

An item may move to `Done` only when:

- All of its acceptance criteria are demonstrated true, with the demonstration method recorded (test name, CLI run, or manual verification log).
- Automated tests covering the acceptance criteria exist and pass in CI (once `ALD-078` exists; before that, tests pass locally and are checked into the same change).
- No known regression is introduced in previously-`Done` items' acceptance criteria (verified by re-running their tests, not by inspection).
- Documentation directly affected by the change is updated in the same change (README, API reference, or the operations runbook once `ALD-079` exists).
- For items feeding an Experiment Readiness Gate (§13), the gate's checklist entry for that item is checked off with a link to the passing evidence, not just implied by the item being `Done`.
- The change does not modify `SPECIFICATION.md`, `EXPERIMENT-NOTEBOOK.md`, or `LEDGER-INTEGRITY-DESIGN.md` — those are read-only inputs to this backlog.

## 8. Release and Milestone Roadmap

Milestones are ordinal and gate-based, not date-based. Each milestone's exit gate is a specific, testable state of specific `ALD-XXX` items, not a calendar target. The milestone sequence loosely mirrors `LEDGER-INTEGRITY-DESIGN.md` [§16. Implementation Phases](LEDGER-INTEGRITY-DESIGN.md#16-implementation-phases) for the evidence/anchoring spine, extended to cover the whole system.

### M0 — Foundations
- **Epics in scope:** EPIC-01 (`ALD-001`–`004`), EPIC-02 (`ALD-005`–`011`).
- **Entry gate:** none (starting point).
- **Exit gate:** `ALD-011` crash-safety tests pass — the hash-chained, WAL-mode evidence store survives induced mid-write crashes with no torn writes. Corresponds to `LEDGER-INTEGRITY-DESIGN.md` [Phase 0: Local Integrity](LEDGER-INTEGRITY-DESIGN.md#phase-0-local-integrity).

### M1 — Verifiable Core
- **Epics in scope:** EPIC-03 (`ALD-012`–`017`), EPIC-05 (`ALD-023`–`028`).
- **Entry gate:** M0 exit met.
- **Exit gate:** `ALD-015` independently validates a real exported bundle, `ALD-027` detects integrity forks, and `ALD-028` proves immutable derived-run lineage. Corresponds to `LEDGER-INTEGRITY-DESIGN.md` [Phase 1: Merkle Proofs](LEDGER-INTEGRITY-DESIGN.md#phase-1-merkle-proofs).

### M2 — Communication and Learners MVP
- **Epics in scope:** EPIC-06 core (`ALD-029`–`030`, `034`–`036`), EPIC-07 (`ALD-037`–`041`), EPIC-08 MVP tracks (`ALD-042`–`045`), EPIC-09 (`ALD-048`–`052`).
- **Entry gate:** M1 exit met.
- **Exit gate:** `ALD-036` fixed-token Gateway conformance suite is green across the full baby-a/baby-b/nursery route set (`ALD-052`), with the no-learning reference (`ALD-042`), frozen-LLM (`ALD-044`), and scratch-RL (`ALD-045`) tracks completing full turns end-to-end.

### M3 — Research-Grade Isolation and Anchoring
- **Epics in scope:** EPIC-04 testnet path (`ALD-018`–`021`), EPIC-10 (`ALD-053`–`057`), EPIC-11 core (`ALD-058`–`060`), EPIC-13 red-team suites (`ALD-067`–`068`), and EPIC-14 foundations/Gate G1 (`ALD-071`–`073`).
- **Entry gate:** M2 exit met.
- **Exit gate:** Mode R isolation, Base Sepolia anchoring, red-team suites, snapshot/restore, and Gate G1 all pass. Corresponds to `LEDGER-INTEGRITY-DESIGN.md` [Phase 2: Testnet Anchoring](LEDGER-INTEGRITY-DESIGN.md#phase-2-testnet-anchoring).

### M4 — Console, Advanced Carriers, and Gate Coverage
- **Epics in scope:** EPIC-06 remaining (`ALD-031`–`033`), EPIC-08 remaining (`ALD-046`–`047`), EPIC-11 remaining (`ALD-061`–`062`), EPIC-12 (`ALD-063`–`066`), EPIC-14 Gates G2-G4 (`ALD-074`–`076`).
- **Entry gate:** M3 exit met.
- **Exit gate:** `ALD-063` dashboard/research console MVP is live and readiness Gates G2-G4 (`ALD-074`–`076`) pass; G1 remains green from M3.

### M5 — Public Anchoring, Cryptography Research, and Release
- **Epics in scope:** EPIC-04 mainnet switch (`ALD-022`), EPIC-13 remaining (`ALD-069`–`070`), EPIC-14 Gate G5 (`ALD-077`), EPIC-15 (`ALD-078`–`080`).
- **Entry gate:** M4 exit met.
- **Exit gate:** Gate G5 (`ALD-077`) passes, `ALD-078` CI is green on the full consolidated suite, and `ALD-080` release/publication mapping is complete. Corresponds to `LEDGER-INTEGRITY-DESIGN.md` [Phase 3: Public Anchoring](LEDGER-INTEGRITY-DESIGN.md#phase-3-public-anchoring).

**Critical path across milestones:** M0 → M1 → M2 → M3 → M4 → M5 is a strict chain — each milestone's epics depend on the previous milestone's evidence/lifecycle foundations. Within M2–M4, epics not named in the critical-path narrative (§10) can proceed in parallel once their own dependencies clear; see §10 for the detailed item-level view.

## 9. Epic Overview

| Epic | Name | Item Range | Depends On (Epics) | Acceptance Gate (summary) |
|---|---|---|---|---|
| EPIC-01 | Repository and Project Scaffolding | ALD-001–004 | none | Monorepo builds; twin pack skeletons exist with unprefixed routes |
| EPIC-02 | Evidence Store and Ledger Integrity Core | ALD-005–011 | EPIC-01 | WAL evidence store, canonical hashing, signing, atomicity survive crash tests |
| EPIC-03 | Merkle Checkpoints and Verifier CLI | ALD-012–017 | EPIC-02 | Independent verifier CLI validates an exported bundle offline |
| EPIC-04 | Base Sepolia and Mainnet Anchoring | ALD-018–022 | EPIC-03 | Checkpoint root anchored and confirmed on Base Sepolia; mainnet gated behind explicit opt-in |
| EPIC-05 | Run and Turn Lifecycle State Machine | ALD-023–028 | EPIC-01, EPIC-02 | State machine, terminal abort, recovery, integrity-fork detection, and derived-run lineage pass |
| EPIC-06 | Symbol Gateway and Communication Protocols | ALD-029–036 | EPIC-02, EPIC-05 | Fixed-token baseline passes first; canvas and affect modules later extend the same conformance suite |
| EPIC-07 | Observation Hygiene, Scenario Engine, and Deterministic Services | ALD-037–041 | EPIC-05, EPIC-06 | Hygiene filter, sanitization, and seeded scenario determinism verified |
| EPIC-08 | Learner Contracts and Model Adapters | ALD-042–047 | EPIC-05, EPIC-07 | All five tracks satisfy the shared interface and contract |
| EPIC-09 | DTSF Twin Packs, API Surface, and Authorization | ALD-048–052 | EPIC-01, EPIC-05, EPIC-06, EPIC-08 | All routes implemented, guarded, and shape-standardized |
| EPIC-10 | Mode R Isolation and Claim-Boundary Controls | ALD-053–057 | EPIC-01, EPIC-09 | Mode R container isolation and claim labels verified |
| EPIC-11 | Telemetry, Audit, Snapshot/Recovery, and Retention | ALD-058–062 | EPIC-02, EPIC-05, EPIC-10 | Telemetry/audit populated; snapshot/restore and retention jobs verified |
| EPIC-12 | Dashboard / Research Console and UX | ALD-063–066 | EPIC-09, EPIC-11 | Console MVP live; prohibited-pattern checklist clean |
| EPIC-13 | Security, Red-Team, and Cryptography Track | ALD-067–070 | EPIC-06, EPIC-07, EPIC-10 | Red-team suites green; crypto novelty/security separation policy enforced |
| EPIC-14 | Experiment Pre-Registration and E00–E50 Readiness Gates | ALD-071–077 | EPIC-05, EPIC-06, EPIC-08, EPIC-13 | Gates G1–G5 all pass; all 19 experiments have a readiness record |
| EPIC-15 | CI/Test Suites, Documentation, Operations, and Release | ALD-078–080 | all prior epics | CI green on consolidated suite; docs and release/publication mapping complete |

## 10. Dependency and Critical Path View

### 10.1 The P0 integrity-and-lifecycle spine

The following chain is the longest dependency path through P0 items — the sequence that gates everything else. Items are shown in dependency order; each depends (directly or transitively) on the one before it.

```
ALD-001 → ALD-002 → ALD-005 → ALD-006 → ALD-007 → ALD-008 → ALD-010 → ALD-011
   → ALD-012 → ALD-013 → ALD-015                                  (verifiable core)
ALD-023 → ALD-024 → ALD-025 → ALD-026 / ALD-027 / ALD-028         (lifecycle)
ALD-029 → ALD-030 → ALD-034 → ALD-036                              (gateway conformance)
ALD-037 → ALD-038 / ALD-039 → ALD-040                               (hygiene)
ALD-042 → ALD-043 → ALD-048 → ALD-049 → ALD-051                   (twins + auth)
ALD-053 → ALD-054                                                    (claim boundary)
ALD-071 → ALD-073 (Gate G1)                                         (first experiment readiness gate)
```

No item off this spine can reach `Done` status meaningfully ahead of its position here, because every later epic (EPIC-06 onward) depends on EPIC-02 and EPIC-05 being functional first.

### 10.2 Items explicitly on the critical path

| ALD ID | Why it is critical-path | Consequence if delayed |
|---|---|---|
| ALD-008 | Hash chaining underlies every later integrity guarantee | Merkle checkpoints (ALD-012) and verifier CLI (ALD-015) cannot start |
| ALD-010 | Atomic transaction wrapper is required by the turn orchestrator | ALD-025 (turn orchestrator) cannot be built correctly |
| ALD-015 | Independent verifier CLI is the first end-to-end proof the integrity design works | Gate G1 (ALD-073) and all anchoring work (EPIC-04) are unverifiable |
| ALD-024 | Run state machine is required by every route and every experiment | Nursery routes (ALD-049), Mode switch (ALD-053), and all gates block |
| ALD-029 | Gateway is the single mediation point for all communication | No protocol (ALD-030/031/033) or twin route (ALD-048) can be wired |
| ALD-048 / ALD-049 | Twin packs are the only way any learner or researcher interacts with the system | Dashboard (EPIC-12), Mode R (EPIC-10), and all gates (EPIC-14) block |
| ALD-071 | Pre-registration binding gates every subsequent experiment readiness gate | Gates G1–G5 (ALD-073–077) cannot be defined as "readiness," only as ad hoc capability |

### 10.3 Parallelizable branches

Once EPIC-02 (`ALD-011`) and EPIC-05 (`ALD-024`) are `Done`, the following branches can proceed **concurrently**, each only depending on the spine above and on items within its own branch:

- **Anchoring branch (EPIC-04):** depends only on EPIC-03, not on EPIC-06/07/08/09.
- **Gateway/protocol branch (EPIC-06) and Hygiene/scenario branch (EPIC-07):** depend on EPIC-05 but not on each other except where noted (`ALD-040` depends on both `ALD-029` and `ALD-037`).
- **Learner adapter branch (EPIC-08):** depends on EPIC-07 (`ALD-037`) but the four adapter tracks (`ALD-044`–`047`) are mutually independent and can be built in parallel by different owners.
- **Security/red-team branch (EPIC-13) items `ALD-067`/`068`:** depend on EPIC-07 and EPIC-10 respectively but not on each other, and not on EPIC-11/12.
- **Telemetry/audit branch (EPIC-11) and Dashboard branch (EPIC-12):** EPIC-11 can start as soon as EPIC-05 and EPIC-02 are done; EPIC-12 must wait on EPIC-11's telemetry (`ALD-058`) and EPIC-09's routes (`ALD-050`).

## 11. First 4 Iterations Execution Plan

Iterations are ordinal, not calendar-based. Each iteration lists parallel workstreams.
Items within one workstream remain dependency-ordered and may start after an earlier
item in the same iteration is complete; an item never starts before all of its listed
dependencies are complete.

### Iteration 1 — Foundations
- **Workstream A (Evidence and Integrity):** `ALD-001`, `ALD-002`, `ALD-003`, `ALD-005`, `ALD-006`, `ALD-007`.
- **Workstream B (Scaffolding):** `ALD-004`.
- **Exit state:** monorepo builds; twin pack skeletons exist; evidence schema, canonicalization, and event-type validation are implemented (not yet chained/signed/atomic).

### Iteration 2 — Chaining, Atomicity, and Checkpoints
- **Workstream A (Evidence and Integrity):** `ALD-008`, `ALD-009`, `ALD-010`, `ALD-011`.
- **Workstream B (Verification):** `ALD-012`, `ALD-013`, `ALD-014`.
- **Workstream C (Lifecycle):** `ALD-023`, `ALD-024`.
- **Exit state:** hash-chained, signed, atomic, crash-safe evidence store; checkpoint manifests generated on schedule; run configuration and run state machine operational.

### Iteration 3 — Verifier, Gateway, and First Adapters
- **Workstream A (Verification):** `ALD-015`, `ALD-016`, `ALD-017`.
- **Workstream B (Lifecycle):** `ALD-025`, `ALD-026`, `ALD-027`, `ALD-028`.
- **Workstream C (Gateway and Protocols):** `ALD-029`, `ALD-030`, `ALD-034`, `ALD-035`, `ALD-036`.
- **Workstream D (Observation and Scenario Core):** `ALD-037`, `ALD-041`, sequenced after `ALD-025`.
- **Workstream E (Adapters):** `ALD-042`, `ALD-043`, `ALD-044`, `ALD-045`, sequenced after `ALD-037`.
- **Exit state:** independent verifier CLI functions against exported bundles; turn orchestrator with pause/abort/recovery, integrity-fork detection, and derived-run lineage is complete; fixed-token conformance is green; deterministic observations and scenarios are available; no-learning, frozen-LLM, and scratch-RL adapters complete full turns.

### Iteration 4 — Twins, Hygiene, Anchoring, and First Gate
- **Workstream A (Twins and API):** `ALD-048`, `ALD-049`, `ALD-050`, `ALD-051`, `ALD-052`.
- **Workstream B (Hygiene and Side Channels):** `ALD-038`, `ALD-039`, `ALD-040`.
- **Workstream C (Anchoring):** `ALD-018`, `ALD-019`, `ALD-020`, `ALD-021`.
- **Workstream D (Mode R):** `ALD-053`, `ALD-054`, `ALD-055`, sequenced after `ALD-049`.
- **Workstream E (Security and Gates):** `ALD-067`, `ALD-068`, `ALD-071`, `ALD-072`, `ALD-073`, sequenced after their Mode R, hygiene, anchoring, scenario, and pre-registration dependencies.
- **Workstream F (Audit and Recovery):** `ALD-058`, `ALD-059`, `ALD-060`, sequenced after lifecycle, evidence, and Mode R dependencies.
- **Exit state:** baby-a/baby-b/nursery routes live with authorization and standardized error shape; observation hygiene, sanitization, and seeded scenario determinism operational; Base Sepolia anchoring confirmed; Gate G1 (E00–E03 readiness) achievable.

**Iteration 5+ (not detailed further here, no dates implied):** continues with the remaining branches — generative carrier and affect protocols (`ALD-031`–033), remaining adapter tracks (`ALD-046`–047), Mode R isolation and telemetry/audit/retention (EPIC-10, EPIC-11), the dashboard (EPIC-12), remaining security/crypto items (`ALD-069`–070), Gates G2–G5 (`ALD-074`–077), and CI/documentation/release (EPIC-15) — in the dependency order fixed by their IDs.

## 12. Backlog Items by Epic

Each item lists: Priority, Size, Classification (MVP / Research-Grade / Later-Research), Depends on, Spec/Experiment references, Scope, and Acceptance Criteria. Checkboxes are used only on acceptance-criteria bullets for these executable items.

### EPIC-01 — Repository and Project Scaffolding

**Goal:** stand up the monorepo, shared types, configuration convention, and twin pack skeletons so every later epic has a place to put code. **Depends on:** none. **Acceptance gate:** the monorepo installs and builds with zero source packages beyond skeletons, and a skeleton twin pack responds on its unprefixed route.

#### ALD-001 — npm workspaces monorepo bootstrap
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** none
- **Spec refs:** `SPECIFICATION.md` [§4.1 Components](SPECIFICATION.md#41-components)
- **Scope:** Initialize root `package.json` with `workspaces` for `packages/*` and `twins/*`; set up shared TypeScript config, lint/format config, and a root build script (`tsc --build` across project references).
- **Acceptance criteria:**
  - [ ] `npm install` at the repo root succeeds with zero workspace packages beyond the initial skeletons.
  - [ ] `npm run build` (project references) compiles with zero errors.
  - [ ] A new package can be added under `packages/*` and is automatically picked up by the workspace without editing the root `package.json`.

#### ALD-002 — Shared `@ald/types` schema package
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-001
- **Spec refs:** `SPECIFICATION.md` [§11 Data Schemas and Interfaces](SPECIFICATION.md#11-data-schemas-and-interfaces)
- **Scope:** Create a `packages/types` package exporting TypeScript types/interfaces (or a schema-validation library's schema objects) for every data structure named in `SPECIFICATION.md` §11 (Run Configuration, Observation, Agent Action Proposal, Ledger Event, Channel Event, Affect Event, Checkpoint Manifest Reference, Anchor Receipt Reference, Experiment Record, Verification Report) as empty/skeleton shapes to be filled in by the epics that own them.
- **Acceptance criteria:**
  - [ ] One exported type/schema exists per §11 subsection (§11.1–§11.10), named to match the section title.
  - [ ] The package builds and is importable from any other workspace package.
  - [ ] A schema-drift test fails if a §11 subsection type is removed without the corresponding source-doc section also changing (a lightweight manifest of expected export names is checked in CI once `ALD-078` exists, and locally before then).

#### ALD-003 — Environment, configuration, and secrets convention
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-001
- **Spec refs:** `SPECIFICATION.md` [§5. Deployment Modes and Claim Boundaries](SPECIFICATION.md#5-deployment-modes-and-claim-boundaries)
- **Scope:** Define the environment-variable and config-file convention used across all packages (e.g., `DTSF_PORT`, mode switch variable, key-material file paths). No secrets are ever committed; document the convention in a `CONFIGURATION.md` or equivalent.
- **Acceptance criteria:**
  - [ ] A documented list of all environment variables exists with defaults and types.
  - [ ] Loading config with a required variable missing fails fast with a clear error, not a silent default.
  - [ ] No secret-shaped value (private key, API token) appears in any committed file; a scan step verifies this.

#### ALD-004 — DTSF twin pack scaffolding (baby-a, baby-b, nursery)
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-001, ALD-002
- **Spec refs:** `SPECIFICATION.md` [§4.1 Components](SPECIFICATION.md#41-components), [§12.1 Route Convention](SPECIFICATION.md#121-route-convention), [§12.4 Baby Twin Routes (baby-a, baby-b)](SPECIFICATION.md#124-baby-twin-routes-baby-a-baby-b), [§12.5 Nursery Controller Routes (nursery)](SPECIFICATION.md#125-nursery-controller-routes-nursery)
- **Scope:** Create three twin pack skeletons (`baby-a`, `baby-b`, `nursery`) with `twin.yaml` manifests, empty `behavior/pack.ts`, and a placeholder route returning `501 Not Implemented`, following the DTSF convention that **route patterns never include the twin-name prefix** (the runtime's `/:twinName/*` route strips it before dispatch).
- **Acceptance criteria:**
  - [ ] All three twin packs load without error when the DTSF runtime scans `twins/packs/`.
  - [ ] Every registered route pattern in all three packs starts with `/`, not `/baby-a`, `/baby-b`, or `/nursery`.
  - [ ] A request to `/baby-a/<placeholder-route>` reaches the handler with `req.params[0]` equal to the unprefixed path, confirmed by an integration test.

### EPIC-02 — Evidence Store and Ledger Integrity Core (Phase 0)

**Goal:** implement the authoritative local SQLite evidence store with canonical hashing, chaining, signing, and atomicity, matching `LEDGER-INTEGRITY-DESIGN.md` Phase 0. **Depends on:** EPIC-01. **Acceptance gate:** `ALD-011` crash-safety tests pass.

#### ALD-005 — SQLite schema migration and WAL mode
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-002, ALD-003
- **Spec refs:** `SPECIFICATION.md` [§13.1 SQLite Schema Additions](SPECIFICATION.md#131-sqlite-schema-additions), `LEDGER-INTEGRITY-DESIGN.md` [§3. Authoritative Local Store](LEDGER-INTEGRITY-DESIGN.md#3-authoritative-local-store)
- **Scope:** Create the SQLite database file, apply the schema from §13.1, enable WAL journal mode, and write a migration runner so schema changes are versioned.
- **Acceptance criteria:**
  - [ ] Database is created with `journal_mode=WAL` confirmed via `PRAGMA journal_mode`.
  - [ ] Every table in §13.1 exists, and event/audit/experiment tables have triggers rejecting `UPDATE` and `DELETE` while versioned records append new rows.
  - [ ] Running the migration twice is idempotent, and an automated test proves privileged application code cannot bypass the append-only triggers.

#### ALD-006 — Canonical ledger event serializer
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-002, ALD-005
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§4. Canonical Ledger Event](LEDGER-INTEGRITY-DESIGN.md#4-canonical-ledger-event), `SPECIFICATION.md` [§11.4 Ledger Event](SPECIFICATION.md#114-ledger-event)
- **Scope:** Implement deterministic canonical serialization (stable key ordering, fixed number/string encoding) of a Ledger Event so that hashing the serialized form is reproducible across processes and platforms.
- **Acceptance criteria:**
  - [ ] Serializing the same logical event twice, in two different process runs, produces byte-identical output.
  - [ ] Key order in the serialized form is independent of the key insertion order of the input object.
  - [ ] A round-trip (serialize → deserialize) produces a deep-equal object to the input.

#### ALD-007 — Event type registry and validators
- **Priority:** P0 · **Size:** S · **Class:** MVP · **Depends on:** ALD-006
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§5. Event Types](LEDGER-INTEGRITY-DESIGN.md#5-event-types)
- **Scope:** Implement the enumerated event-type registry from §5 with a validator per type that checks required fields before an event may be serialized.
- **Acceptance criteria:**
  - [ ] Every event type listed in §5 has a corresponding validator function.
  - [ ] Submitting an event with a missing required field is rejected before reaching the serializer.
  - [ ] Submitting an unknown event type is rejected with a clear error, not silently accepted.

#### ALD-008 — Hash chaining of ledger and channel events
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-006, ALD-007
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§4. Canonical Ledger Event](LEDGER-INTEGRITY-DESIGN.md#4-canonical-ledger-event), [§6. Binding Ledgers to Communication](LEDGER-INTEGRITY-DESIGN.md#6-binding-ledgers-to-communication)
- **Scope:** Implement independent previous-hash chains for Baby A ledger, Baby B ledger, and channel transcript, plus optional affect/audit chains, with the cross-event bindings required by LEDGER §6.
- **Acceptance criteria:**
  - [ ] Each stored event's previous hash matches the immediately preceding event in the same run and event domain, with sequence starting at `1`.
  - [ ] Mutating, deleting, inserting, or reordering an event in any primary chain is detected by a chain-walk validator.
  - [ ] Sender intention, channel event, receiver delivery receipt, and receiver interpretation carry the exact cross-hashes required by LEDGER §6 and SPECIFICATION §11.5.

#### ALD-009 — Per-run event and witness key provisioning
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-008, ALD-003
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§11. Key Management](LEDGER-INTEGRITY-DESIGN.md#11-key-management)
- **Scope:** Provision isolated per-run Ed25519 keys for Baby A ledger, Baby B ledger, channel transcript, optional affect events, generated audit-ledger events, and Nursery checkpoint witness; expose domain-bound signing RPCs and store only public keys in the run manifest.
- **Acceptance criteria:**
  - [ ] Every committed event and checkpoint has a signature verifiable by the public key registered for exactly its domain.
  - [ ] Cross-domain signing attempts fail, including Baby A attempting to sign Baby B or channel content.
  - [ ] Private keys are absent from SQLite, logs, model context, and evidence bundles; per-run rotation produces distinct public keys.

#### ALD-010 — Evidence Writer and atomic turn transaction
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-005, ALD-008, ALD-009
- **Spec refs:** `SPECIFICATION.md` [§8.2 Atomic Ledger+Message Transaction](SPECIFICATION.md#82-atomic-ledgermessage-transaction)
- **Scope:** Implement the single Evidence Writer service from SPECIFICATION §4/§8: authenticate Gateway requests, assign sequences, build canonical events, obtain domain-bound signatures from `ALD-009`, and commit the sender ledger plus channel event in one SQLite transaction.
- **Acceptance criteria:**
  - [ ] A signing or insert failure at any point results in zero sender-ledger and channel rows committed.
  - [ ] A successful `TurnCommitRequest` commits both signed rows atomically and returns their entry hashes before delivery.
  - [ ] Module boundaries and database permissions prevent every other component, including Gateway and Controller, from writing event tables directly.

#### ALD-011 — WAL durability and crash-safety tests
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-005, ALD-010
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§3. Authoritative Local Store](LEDGER-INTEGRITY-DESIGN.md#3-authoritative-local-store), [§15. Recovery and Fork Handling](LEDGER-INTEGRITY-DESIGN.md#15-recovery-and-fork-handling)
- **Scope:** Build a test harness that kills the process mid-write (simulated crash) and verifies the WAL recovers to a consistent last-committed state on restart, with no torn or partial ledger events.
- **Acceptance criteria:**
  - [ ] Simulated crash during an in-flight `ALD-010` transaction leaves the database with either the pre-transaction or post-transaction state, never a partial one, on restart.
  - [ ] The chain-walk validator from `ALD-008` reports zero integrity violations after each crash-recovery test run.
  - [ ] The test suite runs at least 20 randomized crash-point trials in CI (once `ALD-078` exists) without a single torn-write failure.

### EPIC-03 — Merkle Checkpoints and Verifier CLI (Phase 1)

**Goal:** build ordered Merkle checkpoints, an evidence bundle export, and an independent verifier CLI, matching `LEDGER-INTEGRITY-DESIGN.md` Phase 1. **Depends on:** EPIC-02. **Acceptance gate:** `ALD-015` verifier CLI validates a real exported bundle end-to-end.

#### ALD-012 — Ordered Merkle trees and consistency proofs
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-008
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§7. Ordered Merkle Checkpoints](LEDGER-INTEGRITY-DESIGN.md#7-ordered-merkle-checkpoints)
- **Scope:** Implement RFC 6962-style ordered Merkle trees for all present primary and auxiliary event domains, producing roots, inclusion proofs, and prefix-consistency proofs between checkpoint sizes.
- **Acceptance criteria:**
  - [ ] Given a fixed ordered set of event hashes, the builder produces a deterministic, reproducible root hash.
  - [ ] An inclusion proof for any leaf verifies correctly against the root using only the proof and the leaf hash.
  - [ ] Valid extension checkpoints produce a consistency proof, while reordering, deletion, insertion, or a non-prefix tree fails consistency verification.

#### ALD-013 — Checkpoint manifest generation
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-009, ALD-012, ALD-002
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§8. Checkpoint Manifest](LEDGER-INTEGRITY-DESIGN.md#8-checkpoint-manifest), `SPECIFICATION.md` [§11.7 Checkpoint Manifest Reference](SPECIFICATION.md#117-checkpoint-manifest-reference)
- **Scope:** Generate the complete checkpoint manifest with required Baby A/B/channel roots, present auxiliary roots, tree sizes, last hashes, prior-checkpoint hash, run/config/prompt hashes, then obtain the Nursery witness signature from `ALD-009`.
- **Acceptance criteria:**
  - [ ] A generated manifest validates against the authoritative schema and includes every event tree present in the Evidence Store.
  - [ ] Each manifest references the immediately prior checkpoint hash and carries a valid Nursery witness signature.
  - [ ] Every tree size/root exactly matches `ALD-012`, and a missing or extra tree causes checkpoint generation to fail.

#### ALD-014 — Checkpoint frequency scheduler
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-013
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§9. Checkpoint Frequency](LEDGER-INTEGRITY-DESIGN.md#9-checkpoint-frequency)
- **Scope:** Implement the scheduler that triggers checkpoint generation according to the frequency policy in §9 (event-count and/or time-based trigger, as specified).
- **Acceptance criteria:**
  - [ ] A checkpoint is generated automatically once the configured trigger threshold from §9 is reached.
  - [ ] No two checkpoints overlap in event range.
  - [ ] The scheduler is a background timer with the crash-protection convention (registered under the process's `uncaughtException`/`unhandledRejection` handlers) so a scheduling failure logs rather than crashes the server.

#### ALD-015 — Independent verifier CLI
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-012, ALD-013, ALD-009
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§14. Independent Verification](LEDGER-INTEGRITY-DESIGN.md#14-independent-verification)
- **Scope:** Build a standalone CLI with no runtime trust that validates canonical JSON, all event chains/cross-bindings, writer and witness signatures, Merkle roots, inclusion/consistency proofs, checkpoint chains, configuration hashes, forks, gaps, and unanchored tails. Chain-RPC verification is added by `ALD-021`.
- **Acceptance criteria:**
  - [ ] The CLI runs against an exported bundle with no network access and no shared process state with the server.
  - [ ] It accepts an unchanged local bundle and rejects every non-chain mutation case in LEDGER §17 with the correct machine-readable failure location.
  - [ ] It distinguishes chain, signature, inclusion, consistency, checkpoint, fork/gap, and unanchored-tail results.

#### ALD-016 — Evidence bundle export
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-013, ALD-005
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§13. Evidence Bundle](LEDGER-INTEGRITY-DESIGN.md#13-evidence-bundle)
- **Scope:** Implement an export command that packages a run's ledger events, checkpoint manifests, signatures, and (once available) anchor receipts into a portable bundle format per §13.
- **Acceptance criteria:**
  - [ ] The exported bundle contains every event, manifest, and signature needed for `ALD-015` to verify it with no other input.
  - [ ] Exporting the same run twice without intervening writes produces byte-identical bundles.
  - [ ] The bundle format is documented with a schema so a third party could write their own verifier.

#### ALD-017 — Verification report schema and generator
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-015
- **Spec refs:** `SPECIFICATION.md` [§11.10 Verification Report](SPECIFICATION.md#1110-verification-report)
- **Scope:** Formalize the CLI's pass/fail output into the Verification Report structure defined in §11.10 and persist generated reports alongside the bundle they describe.
- **Acceptance criteria:**
  - [ ] Every verifier CLI run (`ALD-015`) produces a report conforming to the `ALD-002` schema for Verification Report.
  - [ ] A failing verification produces a report with machine-readable failure codes, not just free text.
  - [ ] Reports are timestamped and reference the exact bundle export they were generated from.

### EPIC-04 — Base Sepolia and Mainnet Anchoring (Phases 2–3)

**Goal:** anchor checkpoint roots to Base Sepolia by default, with mainnet as an explicit, later opt-in. **Depends on:** EPIC-03. **Acceptance gate:** `ALD-020` anchoring confirmed on Base Sepolia; `ALD-022` mainnet switch remains off by default.

#### ALD-018 — Anchor receipt schema and storage
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-013, ALD-002
- **Spec refs:** `SPECIFICATION.md` [§11.8 Anchor Receipt Reference](SPECIFICATION.md#118-anchor-receipt-reference), `LEDGER-INTEGRITY-DESIGN.md` [§10. Base and L1 Anchoring](LEDGER-INTEGRITY-DESIGN.md#10-base-and-l1-anchoring)
- **Scope:** Define and persist the Anchor Receipt structure (checkpoint reference, chain ID, transaction hash, block number, confirmation status) linked one-to-one with a checkpoint manifest.
- **Acceptance criteria:**
  - [ ] A stored Anchor Receipt validates against the `ALD-002` schema and always references an existing checkpoint manifest (`ALD-013`).
  - [ ] Only a checkpoint root hash and minimal metadata are ever stored as the on-chain payload field — no raw observation or model data.
  - [ ] Querying receipts by checkpoint ID returns at most one receipt per chain per checkpoint.

#### ALD-019 — Anchoring signer key management
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-003, ALD-009
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§11. Key Management](LEDGER-INTEGRITY-DESIGN.md#11-key-management)
- **Scope:** Provision a distinct on-chain signing key (separate from the event-signing key in `ALD-009`) per the §11 key-management convention, with its own storage/rotation path.
- **Acceptance criteria:**
  - [ ] The anchoring key is stored separately from the event-signing key and neither can be derived from the other.
  - [ ] A key-rotation procedure exists and is exercised by a test that anchors before and after rotation without breaking prior receipts' validity.
  - [ ] The anchoring private key is never logged, telemetered, or included in any evidence bundle.

#### ALD-020 — Base Sepolia anchoring client
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-018, ALD-019
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§10. Base and L1 Anchoring](LEDGER-INTEGRITY-DESIGN.md#10-base-and-l1-anchoring), `SPECIFICATION.md` [§13.4 Base Sepolia / Mainnet Anchoring Policy](SPECIFICATION.md#134-base-sepolia--mainnet-anchoring-policy)
- **Scope:** Implement the client that submits a checkpoint root hash to Base Sepolia and records the resulting transaction as an Anchor Receipt (`ALD-018`), with Base Sepolia as the unconditional default target.
- **Acceptance criteria:**
  - [ ] A submitted checkpoint root is independently observable on a public Base Sepolia block explorer.
  - [ ] The default configuration anchors to Base Sepolia with no additional opt-in required.
  - [ ] The submitted on-chain payload contains only the root hash and minimal required metadata, matching `ALD-018`'s privacy criterion.

#### ALD-021 — Anchor confirmation and retry/backoff
- **Priority:** P1 · **Size:** M · **Class:** MVP · **Depends on:** ALD-015, ALD-020
- **Spec refs:** `LEDGER-INTEGRITY-DESIGN.md` [§10. Base and L1 Anchoring](LEDGER-INTEGRITY-DESIGN.md#10-base-and-l1-anchoring)
- **Scope:** Implement finality polling and retry/backoff, then extend the independent verifier to retrieve the transaction through an independently configured RPC, validate chain ID/calldata/receipt/block inclusion, and compare the anchored checkpoint to the final local prefix.
- **Acceptance criteria:**
  - [ ] A receipt is marked `confirmed` only after reaching the configured confirmation depth.
  - [ ] Transient RPC failure retries without duplicate submission; wrong-chain, failed, or nonexistent transactions fail verification.
  - [ ] The verifier reports any event tail after the final anchored checkpoint and independently reproduces the anchored checkpoint hash.

#### ALD-022 — Mainnet anchoring policy switch
- **Priority:** P2 · **Size:** M · **Class:** Later-Research · **Depends on:** ALD-020, ALD-021, ALD-003
- **Spec refs:** `SPECIFICATION.md` [§13.4 Base Sepolia / Mainnet Anchoring Policy](SPECIFICATION.md#134-base-sepolia--mainnet-anchoring-policy)
- **Scope:** Add an explicit, separately-configured mainnet anchoring path reusing the Sepolia client's logic with a different chain configuration, gated behind a distinct opt-in flag that defaults to off.
- **Acceptance criteria:**
  - [ ] With no explicit opt-in set, the system never submits any transaction to mainnet, confirmed by a test that asserts zero mainnet RPC calls under default config.
  - [ ] Enabling the opt-in flag and providing mainnet-specific key/config anchors successfully to mainnet in a manual/staging test.
  - [ ] Switching the opt-in flag off again immediately reverts all anchoring to Base Sepolia with no code change required.

### EPIC-05 — Run and Turn Lifecycle State Machine

**Goal:** implement the run/turn state machine, pause/abort/recovery, integrity-fork detection, and derived-run lineage. **Depends on:** EPIC-01, EPIC-02. **Acceptance gate:** terminal states, fork detection, and derived-run behavior pass conformance tests.

#### ALD-023 — Run configuration schema and validation
- **Priority:** P0 · **Size:** S · **Class:** MVP · **Depends on:** ALD-002
- **Spec refs:** `SPECIFICATION.md` [§11.1 Run Configuration](SPECIFICATION.md#111-run-configuration)
- **Scope:** Implement validation for the Run Configuration schema (`ALD-002`), rejecting configs missing required fields (model track, protocol channel selection, mode) before a run can be created.
- **Acceptance criteria:**
  - [ ] Missing fields and incompatible track/learning-signal, oracle/experiment, or carrier-specific combinations are rejected with field-specific errors.
  - [ ] Valid root and derived configs cover every model, deployment, communication, carrier, affect, and interaction mode; lineage fields are all-or-none.
  - [ ] Validated canonical configs are persisted, hashable, and retrievable by run ID.

#### ALD-024 — Run state machine
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-023
- **Spec refs:** `SPECIFICATION.md` [§7.1 Run States](SPECIFICATION.md#71-run-states), [§7.2 State Transition Table](SPECIFICATION.md#72-state-transition-table)
- **Scope:** Implement the full run-state machine exactly as the §7.2 transition table specifies, rejecting any transition not listed in the table.
- **Acceptance criteria:**
  - [ ] Every transition listed in §7.2 is implemented and unit-tested.
  - [ ] Every transition **not** listed in §7.2 is rejected with an explicit "invalid transition" error, verified by an exhaustive test over all state pairs.
  - [ ] The current state of any run is queryable and matches the last successfully applied transition.

#### ALD-025 — Turn phase orchestrator
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-024, ALD-010
- **Spec refs:** `SPECIFICATION.md` [§8.1 Turn Phases](SPECIFICATION.md#81-turn-phases), [§8.3 Turn Timing and Budgets](SPECIFICATION.md#83-turn-timing-and-budgets)
- **Scope:** Implement the turn-phase sequencing (observation → proposal → validation → commit, per §8.1) driving the `ALD-010` atomic transaction wrapper at the commit phase, enforcing the timing budgets from §8.3.
- **Acceptance criteria:**
  - [ ] Every phase in §8.1 executes in the documented order for a successful turn.
  - [ ] A turn exceeding the §8.3 timing budget is terminated and recorded as a timeout, not left hanging.
  - [ ] The commit phase always goes through the `ALD-010` atomic wrapper — no direct ledger writes bypass it.

#### ALD-026 — Pause/abort handling
- **Priority:** P0 · **Size:** S · **Class:** MVP · **Depends on:** ALD-024
- **Spec refs:** `SPECIFICATION.md` [§7.3 Pause/Abort/Recovery/Fork Behavior](SPECIFICATION.md#73-pause-abort-recovery-fork-behavior)
- **Scope:** Implement pause and abort operations that transition a run to the corresponding §7.1 states, ensuring an in-flight turn either completes its atomic commit or is fully rolled back before the pause/abort takes effect.
- **Acceptance criteria:**
  - [ ] Pausing a run mid-turn either lets the current turn's atomic commit finish or fully rolls it back — never a partial commit.
  - [ ] An `aborted-sealed` run is terminal and can never accept another turn or be reopened.
  - [ ] Pause/abort/resume operations are recorded through the audited intervention path and produce required checkpoints.

#### ALD-027 — Crash recovery and integrity-fork detection
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-011, ALD-025
- **Spec refs:** `SPECIFICATION.md` [§7.3 Pause/Abort/Recovery/Fork Behavior](SPECIFICATION.md#73-pause-abort-recovery-fork-behavior), `LEDGER-INTEGRITY-DESIGN.md` [§15. Recovery and Fork Handling](LEDGER-INTEGRITY-DESIGN.md#15-recovery-and-fork-handling)
- **Scope:** Reconstruct run/turn state from the last consistent evidence prefix after restart, and detect duplicate `(runId, domain, sequence)` entries with mismatched hashes both during writes and recovery.
- **Acceptance criteria:**
  - [ ] After a simulated crash mid-turn, restart reconstructs the run's state to exactly the last atomically committed turn, with no phantom in-progress turn.
  - [ ] A mismatched duplicate sequence preserves both artifacts, transitions the run to `forked-invalid`, halts writes, and requires research-integrity review.
  - [ ] Recovery appends an explicit recovery event at the next unused sequence and matches the state independently derived by `ALD-015`.

#### ALD-028 — Derived-run branching and lineage
- **Priority:** P1 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-024, ALD-016
- **Spec refs:** `SPECIFICATION.md` [§7.4 Derived Runs and Lineage](SPECIFICATION.md#74-derived-runs-and-lineage)
- **Scope:** Implement a new derived run from a specific parent checkpoint, with optional per-Baby replacement policy/adapter, independent event sequences starting at `1`, and immutable parent references.
- **Acceptance criteria:**
  - [ ] A child run records `parentRunId`, `derivedFromCheckpointHash`, and both initial policy refs in config and its first initialization event.
  - [ ] Child sequences restart at `1`, and writes never modify parent evidence or reopen a terminal parent.
  - [ ] `ALD-016` exports lineage references and `ALD-015` verifies them against the immutable parent bundle.

### EPIC-06 — Symbol Gateway and Communication Protocols

**Goal:** implement the single mediating Gateway and its three communication channels (fixed-token, generative carrier, six-display affect) with correct accept/reject behavior. **Depends on:** EPIC-02, EPIC-05. **Acceptance gate:** `ALD-036` conformance suite green across all channels.

#### ALD-029 — Symbol Gateway core router and validator
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-025, ALD-002
- **Spec refs:** `SPECIFICATION.md` [§9. Communication Protocols](SPECIFICATION.md#9-communication-protocols)
- **Scope:** Implement the single mediation point for every inter-agent artifact, registered protocol dispatch, and all six §9.6 communication-control conditions, including seeded substitutions and oracle-only-for-E03 enforcement.
- **Acceptance criteria:**
  - [ ] Every artifact passes through the Gateway; direct Baby-to-Baby routes fail in an instrumented integration test.
  - [ ] `normal`, `disabled`, `constant`, seeded `random`, seeded `shuffled`, and E03-only `oracle` conditions produce their exact §9.6 behavior with no code changes.
  - [ ] Every accepted, rejected, or control-substituted turn records the Baby-proposal hash when present and exact delivered-artifact hash through `ALD-035`.

#### ALD-030 — Fixed-token protocol
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-029
- **Spec refs:** `SPECIFICATION.md` [§9.1 Fixed Token Protocol](SPECIFICATION.md#91-fixed-token-protocol)
- **Scope:** Implement the fixed-token vocabulary channel: a closed, enumerable token set, with the Gateway validating every emitted token against the registered vocabulary.
- **Acceptance criteria:**
  - [ ] Emitting a token in the registered vocabulary is accepted and forwarded.
  - [ ] Emitting any token, string, or byte sequence not in the registered vocabulary is rejected, not silently coerced to the nearest valid token.
  - [ ] The vocabulary is configurable per run without a code change.

#### ALD-031 — Alternate neutral carrier protocols
- **Priority:** P2 · **Size:** L · **Class:** Later-Research · **Depends on:** ALD-029
- **Spec refs:** `SPECIFICATION.md` [§9.2 Alternate Neutral Carrier Protocols](SPECIFICATION.md#92-alternate-neutral-carrier-protocols)
- **Scope:** Implement §9.2's `fixed-glyph`, `generative-bitmap`, `generative-canvas`, and `generative-tone` carrier modules with frozen neutral grammars, hard bounds, RFC 8785 canonicalization, and carrier-qualified content-addressed `markHash` generation.
- **Acceptance criteria:**
  - [ ] Each alternate carrier accepts a valid bounded artifact and reproduces the same carrier-qualified `markHash`.
  - [ ] Out-of-range glyph IDs, bitmap sizes, stroke values, tone bins, text/color fields, and semantic tags are rejected with specific reasons.
  - [ ] Every carrier contributes accept/reject vectors to `ALD-036`, and exactly one carrier family is available in a run.

#### ALD-032 — Alternate-carrier leakage evaluation
- **Priority:** P1 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-031
- **Spec refs:** `SPECIFICATION.md` [§9.2 Alternate Neutral Carrier Protocols](SPECIFICATION.md#92-alternate-neutral-carrier-protocols), [§15.3 Evaluation Baselines and Statistics](SPECIFICATION.md#153-evaluation-baselines-and-statistics)
- **Scope:** Add offline evaluation hooks for measuring whether alternate-carrier artifacts reproduce recognizable human-language forms or encode task/referent information through unintended glyph, bitmap, stroke, or tone features. The evaluator reports evidence and claim-boundary impact; it does not silently rewrite accepted artifacts.
- **Acceptance criteria:**
  - [ ] The evaluator records mark-level leakage metrics and the exact analysis version in the run evidence bundle.
  - [ ] Pre-registered recognizable-glyph and unintended-feature probes produce explicit pass, fail, or inconclusive results without altering the original canvas artifact.
  - [ ] A failed leakage evaluation blocks an ungrounded-language claim while preserving the run as valid negative or integrity evidence.

#### ALD-033 — Six-display affect protocol
- **Priority:** P2 · **Size:** M · **Class:** Later-Research · **Depends on:** ALD-029
- **Spec refs:** `SPECIFICATION.md` [§9.3 Six-Display Affect Protocol](SPECIFICATION.md#93-six-display-affect-protocol)
- **Scope:** Implement declared, permuted, opaque, and derived six-display modes plus emergent-affect routing through the selected alternate carrier. In derived mode, the Gateway maps adapter measurements; the Baby cannot choose a display.
- **Acceptance criteria:**
  - [ ] Declared/permuted/opaque modes emit only A1-A6, while any other display or out-of-window submission is rejected.
  - [ ] Derived mode disables `submit_affect`, records the private measurement, and applies the pre-registered Gateway mapping; emergent mode records a carrier Channel Event rather than an Affect Event.
  - [ ] Affect schemas and every mode's accept/reject vectors extend `ALD-036`, including normalized timing/envelope behavior.

#### ALD-034 — Channel violation detection and rejection behavior
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-029, ALD-030
- **Spec refs:** `SPECIFICATION.md` [§9.4 Rejection Behavior and Channel Violation Handling](SPECIFICATION.md#94-rejection-behavior-and-channel-violation-handling)
- **Scope:** Implement the protocol-independent rejection framework used by every Gateway module: consistent error shape, append-only `channel.rejected` events containing only a rejected-payload hash, rejection counters, and automatic pause after the configured consecutive-rejection ceiling. Fixed-token handling is the first registered module; later canvas and affect modules reuse this framework.
- **Acceptance criteria:**
  - [ ] A fixed-token violation produces the standard rejection shape and an append-only `channel.rejected` event with reason code and payload hash but no raw rejected content.
  - [ ] Five consecutive rejections by default trigger an automatic pause and `safety-trigger` audit entry.
  - [ ] A protocol-module contract test proves canvas and affect handlers can register later without changing the rejection event shape or pause policy.

#### ALD-035 — Turn envelope, channel event, and ledger draft schemas
- **Priority:** P0 · **Size:** S · **Class:** MVP · **Depends on:** ALD-002, ALD-029
- **Spec refs:** `SPECIFICATION.md` [§11.3 Turn and Ledger Proposal Envelopes](SPECIFICATION.md#113-turn-and-ledger-proposal-envelopes), [§11.5 Channel Event](SPECIFICATION.md#115-channel-event)
- **Scope:** Implement and validate Agent Action Proposal, Turn Proposal Envelope, Ledger Draft Envelope, Affect State Measurement, and fully signed Channel Event schemas, wired into Gateway and Evidence Writer boundaries.
- **Acceptance criteria:**
  - [ ] Every Gateway proposal includes one required private intention draft and rejects Baby-supplied run/turn/sender/hash metadata.
  - [ ] Every accepted/rejected event contains the sender-ledger binding, delivery receipt, previous channel hash, entry hash, and channel-writer signature required by §11.5.
  - [ ] Interpretation drafts require the delivered channel hash, and all schema failures use the standard Gateway error shape.

#### ALD-036 — Gateway/protocol conformance test suite
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-030, ALD-034, ALD-035
- **Spec refs:** `SPECIFICATION.md` [§9. Communication Protocols](SPECIFICATION.md#9-communication-protocols), [§17.2 Test Strategy](SPECIFICATION.md#172-test-strategy)
- **Scope:** Build an extensible automated conformance suite for registered Gateway protocols, rejection behavior, and schema validation, runnable independently of any learner adapter. The fixed-token module is the MVP gate; `ALD-031` and `ALD-033` must add canvas and affect vectors before those modules are declared done.
- **Acceptance criteria:**
  - [ ] The MVP suite exercises fixed-token acceptance/rejection, all six communication controls, dual proposal/delivery hashing, consecutive-rejection pause, and schema failures.
  - [ ] The suite runs against a mocked/stub learner, with no dependency on any specific `ALD-044`–047 adapter.
  - [ ] A protocol registration test requires every enabled module to contribute accept/reject vectors; the consolidated suite is the gate referenced by EPIC-06 and `ALD-078`.

### EPIC-07 — Observation Hygiene, Scenario Engine, and Deterministic Services

**Goal:** ensure agents only observe what they are permitted to, harden the transport against injection and side channels, and provide a deterministic, seeded scenario/task engine. **Depends on:** EPIC-05, EPIC-06. **Acceptance gate:** hygiene filter, sanitization, and seeded determinism all verified.

#### ALD-037 — Observation schema and builder
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-002, ALD-025
- **Spec refs:** `SPECIFICATION.md` [§11.2 Observation](SPECIFICATION.md#112-observation)
- **Scope:** Implement the Observation builder that assembles exactly the fields §11.2 defines for a given turn, from world/scenario state, with no additional fields leaking in.
- **Acceptance criteria:**
  - [ ] A built Observation validates against the `ALD-002` schema and contains no field not listed in §11.2.
  - [ ] Two observations built from identical underlying state are byte-identical after canonicalization (reusing `ALD-006`'s approach).
  - [ ] The builder is the only code path producing Observations delivered to learners.

#### ALD-038 — Observation hygiene filter
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-037
- **Spec refs:** `SPECIFICATION.md` [§10.1 Observation Hygiene](SPECIFICATION.md#101-observation-hygiene)
- **Scope:** Implement the filter that strips or blocks any observation content prohibited by §10.1 (e.g., internal identifiers, other agent's private state, out-of-scenario metadata) before delivery.
- **Acceptance criteria:**
  - [ ] Every prohibited field category listed in §10.1 is demonstrated blocked using a test observation deliberately constructed to contain it.
  - [ ] The filter runs on every Observation before it reaches the Gateway/learner boundary, with no bypass path.
  - [ ] A blocked field produces an audit-logged event (feeding `ALD-059`), not a silent drop.

#### ALD-039 — OCR detection and scenario-bundle quarantine
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-037
- **Spec refs:** `SPECIFICATION.md` [§10.2 Prompt Injection Controls](SPECIFICATION.md#102-prompt-injection-controls)
- **Scope:** Scan every scene and asset for OCR-visible text before scenario registration. Any detected glyph or text causes the complete bundle to fail observation hygiene and enter quarantine; prohibited text is never sanitized and passed through.
- **Acceptance criteria:**
  - [ ] A bundle containing OCR-detected text, caption metadata, semantic filenames, or human-readable labels cannot be referenced by a run.
  - [ ] Text-free controls pass while pre-registered adversarial image/text fixtures are quarantined before any adapter receives them.
  - [ ] Quarantine events retain artifact hashes and reason codes without exposing raw injection text in Baby-visible or public logs.

#### ALD-040 — Side-channel elimination in transport layer
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-029, ALD-037
- **Spec refs:** `SPECIFICATION.md` [§10.3 Side Channel Controls](SPECIFICATION.md#103-side-channel-controls)
- **Scope:** Audit and close the transport-level side channels named in §10.3 (e.g., timing channels, response-size channels, error-message channels) in the Gateway and Observation delivery path.
- **Acceptance criteria:**
  - [ ] Each side-channel category named in §10.3 has a corresponding mitigation implemented (e.g., constant-shape error responses, timing normalization where specified).
  - [ ] A test harness measuring the relevant channel (e.g., response latency variance) confirms the mitigation is effective within the tolerance §10.3 implies.
  - [ ] This item's test harness is reused (not duplicated) by the red-team suite in `ALD-067`.

#### ALD-041 — Deterministic scenario/task engine
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-023, ALD-037
- **Spec refs:** `SPECIFICATION.md` [§9.5 Interaction and Utility Profiles](SPECIFICATION.md#95-interaction-and-utility-profiles), [§15.3 Evaluation Baselines and Statistics](SPECIFICATION.md#153-evaluation-baselines-and-statistics), [§17.3 Phased Delivery](SPECIFICATION.md#173-phased-delivery)
- **Scope:** Implement the scenario/task generator that deterministically produces scenario states, private observations, utility matrices, reservation values, and zones of possible agreement from run configuration and seed for all five §9.5 interaction profiles.
- **Acceptance criteria:**
  - [ ] Two runs with the same seed and interaction mode produce byte-identical scenarios, private facts, utilities, and task sequences.
  - [ ] Every §9.5 interaction profile produces its required utility relationship, including a provably empty zone of possible agreement for `no-agreement-control`.
  - [ ] The engine's output feeds `ALD-037`'s Observation builder with no intermediate non-deterministic step.

### EPIC-08 — Learner Contracts and Model Adapters

**Goal:** implement the shared Learner Adapter interface and all five model tracks named in the spec. **Depends on:** EPIC-05, EPIC-07. **Acceptance gate:** the no-learning reference plus frozen-LLM, scratch-RL, self-supervised, and hybrid tracks satisfy the shared interface and complete full turns.

#### ALD-042 — Learner Adapter interface
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-037
- **Spec refs:** `SPECIFICATION.md` [§6.2 Learner Adapter Interface](SPECIFICATION.md#62-learner-adapter-interface)
- **Scope:** Define the shared TypeScript interface every model track must implement (receive Observation, return Agent Action Proposal, lifecycle hooks) exactly matching §6.2, and provide the deterministic/fixed `no-learning` reference adapter used for chance controls.
- **Acceptance criteria:**
  - [ ] The interface implements every §6.2 method, including `receive(DeliveredChannelArtifact)` returning a `LedgerDraftEnvelope`.
  - [ ] The `no-learning` reference adapter is selectable, performs no policy update, and passes the contract-conformance test.
  - [ ] The interface is the only integration point the turn orchestrator (`ALD-025`) uses to reach a learner.

#### ALD-043 — Learner contract versioning, lint, and tool-only enforcement
- **Priority:** P0 · **Size:** L · **Class:** Research-Grade · **Depends on:** ALD-042
- **Spec refs:** `SPECIFICATION.md` [§6.3 Tool-Only Interaction Contract](SPECIFICATION.md#63-tool-only-interaction-contract), [§6.4 Learner Contract Versioning](SPECIFICATION.md#64-learner-contract-versioning)
- **Scope:** Implement immutable versioned learner-contract files, CI lint that rejects semantic examples/sample exchanges/banned patterns, prompt-bundle hashing, and runtime enforcement that every adapter acts only through the declared tools and Gateway.
- **Acceptance criteria:**
  - [ ] A contract containing a symbol-meaning example, sample exchange, or prohibited side-channel instruction fails CI and cannot be referenced by a run.
  - [ ] Referenced contract versions are immutable and their prompt-bundle hashes appear in run evidence.
  - [ ] The no-learning reference and all four adapter tracks are blocked and audited when attempting any state write or output outside the §6.3 tool surface.

#### ALD-044 — Frozen-LLM adapter with local open-weight default
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-042, ALD-043
- **Spec refs:** `SPECIFICATION.md` [§6.7 Model Recommendations (Defaults)](SPECIFICATION.md#67-model-recommendations-defaults), [§6.1 Track Definitions](SPECIFICATION.md#61-track-definitions)
- **Scope:** Implement the `frozen-llm` adapter using a locally deployable 3B–8B open-weight instruction model by default, with frozen weights, separate private memory, constrained tool calls, and no network access.
- **Acceptance criteria:**
  - [ ] The `frozen-llm` track is selectable via `ALD-023` run configuration and records the exact model and weight hashes.
  - [ ] A full turn (observation → proposal → Gateway validation → commit) completes end-to-end using this adapter.
  - [ ] The adapter exposes no weight-update path and passes the `ALD-036` Gateway conformance suite.

#### ALD-045 — From-scratch RL learner track
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-042, ALD-043
- **Spec refs:** `SPECIFICATION.md` [§6.1 Track Definitions](SPECIFICATION.md#61-track-definitions), `EXPERIMENT-NOTEBOOK.md` [E11 — From-Scratch RL Naming Game](EXPERIMENT-NOTEBOOK.md#e11-from-scratch-rl-naming-game)
- **Scope:** Implement the `scratch-rl` GRU/LSTM actor-critic adapter with independent PPO-style updates, random initialization, private buffers, and policy checkpoint output.
- **Acceptance criteria:**
  - [ ] The track starts from randomly initialized parameters whose initial hash is recorded in the evidence bundle.
  - [ ] A full turn and minimal reward-to-parameter-update cycle complete end-to-end in both pre-registered extrinsic-reward and intrinsic-motivation modes.
  - [ ] Policy updates use only the Baby's private buffers and emit a verifiable policy checkpoint reference.

#### ALD-046 — Self-supervised ungrounded learner track
- **Priority:** P1 · **Size:** L · **Class:** Later-Research · **Depends on:** ALD-042, ALD-043
- **Spec refs:** `SPECIFICATION.md` [§6.1 Track Definitions](SPECIFICATION.md#61-track-definitions), `EXPERIMENT-NOTEBOOK.md` [E12 — Self-Supervised Ungrounded Baseline](EXPERIMENT-NOTEBOOK.md#e12-self-supervised-ungrounded-baseline)
- **Scope:** Implement the `self-supervised` adapter with the same recurrent backbone as `scratch-rl` where feasible, using a pre-registered predictive or contrastive loss and no scalar reward.
- **Acceptance criteria:**
  - [ ] The track is selectable, starts from recorded random initialization, and rejects any scalar reward supplied to its update path.
  - [ ] A full turn and minimal predictive/contrastive update complete end-to-end.
  - [ ] The evidence bundle records the loss definition and proves that outcome labels are not included in the self-supervised update batch.

#### ALD-047 — Hybrid learner track
- **Priority:** P1 · **Size:** L · **Class:** Later-Research · **Depends on:** ALD-042, ALD-043
- **Spec refs:** `SPECIFICATION.md` [§6.1 Track Definitions](SPECIFICATION.md#61-track-definitions), [§6.5 Semantic-Leakage Test Battery](SPECIFICATION.md#65-semantic-leakage-test-battery)
- **Scope:** Implement the `hybrid` adapter using a from-scratch sensory encoder, recurrent world model, and randomly initialized communication policy, with optional frozen low-level visual features only after semantic-leakage qualification.
- **Acceptance criteria:**
  - [ ] The track is selectable and records the provenance and hashes of every sensory, world-model, and communication component.
  - [ ] A full turn and minimal policy update complete end-to-end through the shared interface.
  - [ ] Any text-aligned frozen feature automatically weakens the run's claim classification; strict ungrounded classification requires `ALD-057` to pass.

### EPIC-09 — DTSF Twin Packs, API Surface, and Authorization

**Goal:** implement the full baby-a/baby-b/nursery route surface with authorization and a standardized response shape. **Depends on:** EPIC-01, EPIC-05, EPIC-06, EPIC-08. **Acceptance gate:** all routes implemented, guarded, and shape-standardized.

#### ALD-048 — baby-a / baby-b twin pack implementation
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-004, ALD-029, ALD-042
- **Spec refs:** `SPECIFICATION.md` [§12.4 Baby Twin Routes (baby-a, baby-b)](SPECIFICATION.md#124-baby-twin-routes-baby-a-baby-b)
- **Scope:** Replace the `ALD-004` skeleton routes with full implementations of every route listed in §12.4, wired to the Gateway (`ALD-029`) and a selected learner adapter (`ALD-042`-conformant).
- **Acceptance criteria:**
  - [ ] Every route in §12.4, including Gateway-only `/deliver`, exists on both `baby-a` and `baby-b`, all unprefixed.
  - [ ] Each route's behavior matches its documented purpose in §12.4 (verified by an integration test per route).
  - [ ] A full run using these twin packs completes at least one turn end-to-end through the Gateway.

#### ALD-049 — Nursery controller twin pack
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-024, ALD-048
- **Spec refs:** `SPECIFICATION.md` [§12.5 Nursery Controller Routes (nursery)](SPECIFICATION.md#125-nursery-controller-routes-nursery)
- **Scope:** Implement the nursery controller's routes for creating/starting/pausing/aborting runs and creating derived runs, driving the `ALD-024` state machine and `ALD-028` lineage service while orchestrating both Baby twins.
- **Acceptance criteria:**
  - [ ] Every route in §12.5 exists, unprefixed, and drives the correct `ALD-024` state transition.
  - [ ] Creating a run via nursery correctly provisions both `baby-a` and `baby-b` instances.
  - [ ] Pausing/aborting and derived-run creation use the same state/lineage services as direct internal calls, with no divergent logic path or reopening of terminal parents.

#### ALD-050 — Evidence and verification routes on nursery
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-016, ALD-049
- **Spec refs:** `SPECIFICATION.md` [§12.6 Evidence and Verification Routes (nursery)](SPECIFICATION.md#126-evidence-and-verification-routes-nursery)
- **Scope:** Implement the nursery routes for triggering evidence bundle export (`ALD-016`) and retrieving verification reports (`ALD-017`), per §12.6.
- **Acceptance criteria:**
  - [ ] Every route in §12.6 exists, unprefixed, and returns data conforming to the `ALD-002` schemas involved.
  - [ ] Triggering an export via this route produces a bundle identical to calling `ALD-016`'s export function directly.
  - [ ] Unauthorized callers (per `ALD-051`) cannot reach these routes.

#### ALD-051 — Authorization roles and route guards
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-048, ALD-049, ALD-050
- **Spec refs:** `SPECIFICATION.md` [§12.2 Authorization Roles](SPECIFICATION.md#122-authorization-roles)
- **Scope:** Implement the role model and route guards from §12.2 across all twin routes, denying access to any role not explicitly permitted for a given route.
- **Acceptance criteria:**
  - [ ] Every role defined in §12.2 is enforced on every route that names a restriction.
  - [ ] Missing/invalid credentials return `401 UNAUTHENTICATED`; valid identities with insufficient roles return `403 FORBIDDEN`.
  - [ ] A test matrix of (role × route) confirms allow/deny matches §12.2 exactly.

#### ALD-052 — Response and error shape standardization
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-048, ALD-049, ALD-050
- **Spec refs:** `SPECIFICATION.md` [§12.3 Response and Error Shape](SPECIFICATION.md#123-response-and-error-shape)
- **Scope:** Apply the standardized success/error response envelope from §12.3 to every route across all three twin packs.
- **Acceptance criteria:**
  - [ ] Every success response across all routes matches the §12.3 success envelope.
  - [ ] Every error response across all routes matches the §12.3 error envelope, including the ones from `ALD-034`'s channel violations.
  - [ ] A lint/test rule fails the build if a new route is added without conforming to the envelope.

### EPIC-10 — Mode R Isolation and Claim-Boundary Controls

**Goal:** implement the Mode P / Mode R deployment switch, claim-boundary enforcement, container isolation, and training isolation. **Depends on:** EPIC-01, EPIC-09. **Acceptance gate:** Mode R container isolation and claim labels verified.

#### ALD-053 — Mode P / Mode R deployment switch
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-003, ALD-049
- **Spec refs:** `SPECIFICATION.md` [§5.1 Prototype Mode (Mode P)](SPECIFICATION.md#51-prototype-mode-mode-p), [§5.2 Research-Grade Mode (Mode R)](SPECIFICATION.md#52-research-grade-mode-mode-r), [§5.3 Mode Comparison Table](SPECIFICATION.md#53-mode-comparison-table)
- **Scope:** Implement the configuration switch selecting Mode P or Mode R for a run, wiring each mode's distinct behaviors from §5.3 (e.g., isolation strictness, claim labeling) into the nursery run-creation path.
- **Acceptance criteria:**
  - [ ] A run created under Mode P and one under Mode R differ exactly along the dimensions listed in §5.3 — no undocumented behavioral difference.
  - [ ] The mode is immutable for the lifetime of a run once created (cannot be switched mid-run).
  - [ ] The active mode is recorded in the Run Configuration and visible in every exported evidence bundle.

#### ALD-054 — Claim-boundary enforcement
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-053
- **Spec refs:** `SPECIFICATION.md` [§5.4 Claim Boundary Statements](SPECIFICATION.md#54-claim-boundary-statements)
- **Scope:** Implement automated checks that block any dashboard/report/export from asserting a Mode-R-only claim (e.g., "isolation-verified") about a run that actually executed in Mode P.
- **Acceptance criteria:**
  - [ ] Every claim statement listed in §5.4 is machine-checked against the run's actual recorded mode before being allowed to render/export.
  - [ ] A Mode P run attempting to surface a Mode-R-only claim label is blocked with a specific error, not silently downgraded.
  - [ ] The check is exercised by an automated test for every claim statement in §5.4, not spot-checked manually.

#### ALD-055 — Separate-container isolation for Mode R
- **Priority:** P1 · **Size:** L · **Class:** Research-Grade · **Depends on:** ALD-053
- **Spec refs:** `SPECIFICATION.md` [§5.2 Research-Grade Mode (Mode R)](SPECIFICATION.md#52-research-grade-mode-mode-r)
- **Scope:** Run each learner adapter in Mode R in its own container/process with no shared mutable memory, communicating only through the Gateway and evidence store.
- **Acceptance criteria:**
  - [ ] In Mode R, `baby-a` and `baby-b` learner processes run in distinct OS processes/containers, verified by distinct process IDs / container IDs.
  - [ ] No in-memory object reference is shared between the two learner containers (verified by an isolation test attempting cross-container object access and observing failure).
  - [ ] Killing one learner container does not corrupt or crash the other, or the Gateway/evidence store.

#### ALD-056 — Training isolation guarantees
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-055, ALD-045, ALD-046, ALD-047
- **Spec refs:** `SPECIFICATION.md` [§10.4 Training Isolation](SPECIFICATION.md#104-training-isolation)
- **Scope:** Verify and enforce that every trainable learner's update process (`scratch-rl`, `self-supervised`, and `hybrid`) cannot access the other agent's private state, replay data, gradients, optimizer, or parameters.
- **Acceptance criteria:**
  - [ ] Each trainable learner's update step reads only from its own adapter's local buffers, never from the counterpart process.
  - [ ] An isolation test that attempts to smuggle counterpart-agent internal state into a training update fails to do so, confirmed by the test.
  - [ ] Training isolation is verified specifically under Mode R container separation (`ALD-055`), not just asserted for Mode P.

#### ALD-057 — Semantic-leakage test battery automation
- **Priority:** P1 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-038, ALD-044, ALD-045, ALD-046, ALD-047
- **Spec refs:** `SPECIFICATION.md` [§6.5 Semantic Leakage Test Battery](SPECIFICATION.md#65-semantic-leakage-test-battery)
- **Scope:** Implement the full §6.5 adapter test battery: tokenizer/vocabulary audit, frozen-feature linear probe against label-shuffled controls, and vision-language encoder classification, with claim-boundary results persisted in run evidence.
- **Acceptance criteria:**
  - [ ] Every test in §6.5 runs against `scratch-rl`, `self-supervised`, and strict `hybrid`; frozen-LLM and no-learning runs are explicitly classified rather than incorrectly presented as ungrounded.
  - [ ] Linear-probe evaluation uses the pre-registered 95% label-shuffled confidence-interval rule.
  - [ ] Battery results are attached to the run's evidence record so a reviewer can see leakage-test outcomes per run.

### EPIC-11 — Telemetry, Audit, Snapshot/Recovery, and Retention

**Goal:** implement telemetry, audit logging, snapshot/restore, failure handling, and retention. **Depends on:** EPIC-02, EPIC-05, EPIC-10. **Acceptance gate:** telemetry/audit populated; snapshot/restore and retention verified.

#### ALD-058 — Telemetry event pipeline
- **Priority:** P1 · **Size:** M · **Class:** MVP · **Depends on:** ALD-025, ALD-005
- **Spec refs:** `SPECIFICATION.md` [§14.1 Telemetry](SPECIFICATION.md#141-telemetry)
- **Scope:** Implement the telemetry pipeline capturing per-request/per-turn metrics (method, path, status, duration) named in §14.1, persisted for dashboard consumption.
- **Acceptance criteria:**
  - [ ] Every API request across all twin routes produces a telemetry record with the fields §14.1 requires.
  - [ ] Telemetry recording failures never block or fail the underlying request (verified by fault-injection test on the telemetry sink).
  - [ ] Telemetry data is queryable by run ID and by time range.

#### ALD-059 — Audit, intervention, and safety-event logging
- **Priority:** P0 · **Size:** L · **Class:** Research-Grade · **Depends on:** ALD-013, ALD-024, ALD-053
- **Spec refs:** `SPECIFICATION.md` [§14.2 Audit Logging](SPECIFICATION.md#142-audit-logging)
- **Scope:** Implement append-only audit records for human views, operator interventions, and safety triggers. Pause/resume/abort/annotate actions must use this path, record actor/reason, and request the mandatory checkpoint; unplanned interventions also create a notebook deviation reference.
- **Acceptance criteria:**
  - [ ] Every §14.2 human view/intervention and §14.5 safety trigger produces an append-only audit record with authenticated actor and machine-readable reason.
  - [ ] Each intervention produces a signed checkpoint, and any unplanned intervention links to an append-only notebook deviation record.
  - [ ] Audit and intervention logs plus checkpoint references are included in every evidence bundle, not only Mode R.

#### ALD-060 — Snapshot and restore mechanism
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-005, ALD-011
- **Spec refs:** `SPECIFICATION.md` [§14.4 Snapshot and Restore](SPECIFICATION.md#144-snapshot-and-restore)
- **Scope:** Implement periodic and on-demand snapshotting of all runtime state to serialized files, and a restore path that reconstructs state from the latest snapshot on startup, per §14.4.
- **Acceptance criteria:**
  - [ ] A manual "take snapshot now" action produces a snapshot file set that a restore can consume.
  - [ ] Restarting the server after a snapshot automatically restores to that snapshot's state (`autoRestore()`-equivalent behavior).
  - [ ] A restored run's evidence-store state matches, byte-for-byte in the chain-walk sense (`ALD-008`), the state at the moment the snapshot was taken.

#### ALD-061 — Failure handling policy implementation
- **Priority:** P0 · **Size:** M · **Class:** MVP · **Depends on:** ALD-011, ALD-021
- **Spec refs:** `SPECIFICATION.md` [§14.5 Failure Handling](SPECIFICATION.md#145-failure-handling)
- **Scope:** Implement the documented failure-handling policy for each named failure mode in §14.5 (evidence-store failure, anchoring failure, learner adapter crash), including registering `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers so background tasks (checkpoint scheduler, anchoring retries) log rather than crash the server.
- **Acceptance criteria:**
  - [ ] Every failure mode named in §14.5 has an implemented, tested handling path.
  - [ ] An unhandled rejection thrown from a background task (e.g., a failed anchor confirmation poll) is caught, logged, and does not crash the server process, confirmed by a fault-injection test.
  - [ ] The failure-handling behavior for anchoring failures reuses `ALD-021`'s retry/backoff rather than a separate ad hoc mechanism.

#### ALD-062 — Retention policy enforcement job
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-005, ALD-016
- **Spec refs:** `SPECIFICATION.md` [§14.6 Retention Policy](SPECIFICATION.md#146-retention-policy)
- **Scope:** Purge bulk payload files only for non-public development/qualification runs that are not Base-mainnet anchored and exceed `prototypeRetentionDays`; preserve append-only database events, audit/intervention logs, manifests, receipts, and run index metadata.
- **Acceptance criteria:**
  - [ ] Only eligible non-public, non-mainnet run-bundle payloads are purged; public or mainnet-anchored bundles are retained indefinitely.
  - [ ] `run_metadata`, ledger/channel/audit/intervention rows, checkpoint manifests, and anchor receipts remain queryable after purge.
  - [ ] The job's actions are themselves audit-logged (`ALD-059`).

### EPIC-12 — Dashboard / Research Console and UX

**Goal:** build the MVP dashboard/research console within the documented UX boundaries. **Depends on:** EPIC-09, EPIC-11. **Acceptance gate:** console MVP live; prohibited-pattern checklist clean.

#### ALD-063 — Dashboard/research console MVP
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-050, ALD-058
- **Spec refs:** `SPECIFICATION.md` [§16.1 Dashboard and Research Console](SPECIFICATION.md#161-dashboard-and-research-console)
- **Scope:** Build the vanilla-JS Research Console with run/pre-registration status, separated Baby perspectives, public transcript, read-only audit-ledger comparison, checkpoint/anchor/verification state, telemetry, and operator-gated lifecycle controls.
- **Acceptance criteria:**
  - [ ] The console displays live run/pre-registration state, public transcript, telemetry, verification, checkpoint, and anchor data from authoritative routes.
  - [ ] Baby A/B observations and audit ledgers render in clearly separated read-only panels, and operator controls are role-gated and audited.
  - [ ] The console is a self-contained vanilla HTML/CSS/JS page with no frontend framework, build tool, or client-side side-channel route.

#### ALD-064 — Human audit-ledger Interpreter
- **Priority:** P1 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-005, ALD-016, ALD-042
- **Spec refs:** `SPECIFICATION.md` [§13.6 Privacy Controls](SPECIFICATION.md#136-privacy-controls)
- **Scope:** Implement delayed/batched conversion of agent-native ledger state into separately signed, append-only `audit_ledger_entries`, labeled `source: generated-analysis`, with no Baby-readable route or feedback path.
- **Acceptance criteria:**
  - [ ] Every generated interpretation references source native events and is explicitly labeled external analysis.
  - [ ] Baby identities cannot read audit-ledger entries, while authorized researchers and the verifier can.
  - [ ] Audit entries are included in their checkpoint auxiliary tree and exported evidence without modifying native ledger events.

#### ALD-065 — Prohibited UX pattern review checklist
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-063
- **Spec refs:** `SPECIFICATION.md` [§16.2 Diplomacy Table Reuse Boundaries](SPECIFICATION.md#162-diplomacy-table-reuse-boundaries), [§16.3 Prohibited UX Patterns](SPECIFICATION.md#163-prohibited-ux-patterns)
- **Scope:** Audit every reused Diplomacy-style component and run a checklist against all prohibited side-channel, misleading-claim, caucus, coalition, and direct-relay patterns.
- **Acceptance criteria:**
  - [ ] Every reused component is listed with its permitted §16.2 mapping, and no Diplomacy game logic or side-channel route is imported.
  - [ ] Any failing item blocks `ALD-063` from being marked `Done` until resolved.
  - [ ] Every §16.3 prohibition has a pass/fail result, and the checklist reruns after material dashboard changes.

#### ALD-066 — Automated replay fidelity and viewer
- **Priority:** P1 · **Size:** L · **Class:** Research-Grade · **Depends on:** ALD-041, ALD-063
- **Spec refs:** `SPECIFICATION.md` [§14.3 Reproducibility and Replay Fidelity](SPECIFICATION.md#143-reproducibility-and-replay-fidelity)
- **Scope:** Implement scenario replay and deterministic execution `replayDigest` generation/verification per §14.3, then expose the results in a read-only dashboard viewer.
- **Acceptance criteria:**
  - [ ] Same-seed scenario replay reproduces scenario/observation hashes; wrong-seed replay fails automatically.
  - [ ] Deterministic adapters reproduce the §14.3 replay digest, while nondeterministic adapters are explicitly `not-applicable` and pass recorded-decision playback only.
  - [ ] The viewer displays machine results and remains read-only; it cannot alter evidence or override a failure.

### EPIC-13 — Security, Red-Team, and Cryptography Track

**Goal:** build red-team harnesses for side-channel and prompt-injection controls, the ephemeral-encoding research harness, and the crypto novelty/security separation policy. **Depends on:** EPIC-06, EPIC-07, EPIC-10. **Acceptance gate:** red-team suites green; separation policy enforced.

#### ALD-067 — Side-channel red-team harness
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-040, ALD-055
- **Spec refs:** `SPECIFICATION.md` [§10.3 Side Channel Controls](SPECIFICATION.md#103-side-channel-controls), `EXPERIMENT-NOTEBOOK.md` [E01 — Channel Isolation and Side-Channel Red-Team](EXPERIMENT-NOTEBOOK.md#e01-channel-isolation-and-side-channel-red-team)
- **Scope:** Build an adversarial test harness that actively attempts to exploit each side channel `ALD-040` claims to have closed, reusing its measurement tooling, sufficient to support `E01`.
- **Acceptance criteria:**
  - [ ] The harness includes at least one active exploit attempt per side-channel category named in §10.3.
  - [ ] Every exploit attempt fails to extract cross-agent information, confirmed by an automated pass/fail check, not manual judgment.
  - [ ] The harness runs under both Mode P and Mode R (`ALD-053`) so `E01`'s isolation comparison is possible.

#### ALD-068 — Observation-text and quarantine-bypass red-team suite
- **Priority:** P0 · **Size:** M · **Class:** Research-Grade · **Depends on:** ALD-039
- **Spec refs:** `SPECIFICATION.md` [§10.2 Prompt Injection Controls](SPECIFICATION.md#102-prompt-injection-controls), `EXPERIMENT-NOTEBOOK.md` [E02 — Observation and Metadata Leakage Audit](EXPERIMENT-NOTEBOOK.md#e02-observation-and-metadata-leakage-audit)
- **Scope:** Build adversarial scenario bundles that hide text in pixels, metadata, filenames, alternate encodings, and malformed assets, attempting to bypass `ALD-039` and reach a Baby observation.
- **Acceptance criteria:**
  - [ ] The suite includes direct text, low-contrast/OCR-evasion fixtures, metadata labels, semantic filenames, and malformed-image cases.
  - [ ] Every positive fixture is quarantined and zero raw text reaches an adapter context; negative text-free controls remain loadable.
  - [ ] Results are exported as hashed evidence linked from the E02 Experiment Record, not misrepresented as the Experiment Record itself.

#### ALD-069 — Ephemeral encoding and adversarial cryptography research harness
- **Priority:** P2 · **Size:** L · **Class:** Later-Research · **Depends on:** ALD-031, ALD-057
- **Spec refs:** `SPECIFICATION.md` [§18. Experiment Variable Registry](SPECIFICATION.md#18-experiment-variable-registry), `EXPERIMENT-NOTEBOOK.md` [E40 — Ephemeral Encoding and Adversarial Cryptography](EXPERIMENT-NOTEBOOK.md#e40-ephemeral-encoding-and-adversarial-cryptography)
- **Scope:** Build the research harness needed for `E40` — instrumentation to let two learners develop and test ephemeral, session-specific encodings over the generative carrier channel (`ALD-031`), with a third-party eavesdropper role able to attempt decoding.
- **Acceptance criteria:**
  - [ ] The harness supports at least three roles in a single run: two communicating learners and one eavesdropper observer.
  - [ ] The harness logs every encoding scheme change as a distinct, timestamped event so `E40` can measure encoding lifetime.
  - [ ] The harness itself makes no claim about cryptographic security — it only provides the measurement/instrumentation `E40`'s research execution needs; a passing harness build is not a security claim.

#### ALD-070 — Cryptographic novelty-vs-security separation policy
- **Priority:** P0 · **Size:** S · **Class:** Later-Research · **Depends on:** ALD-009, ALD-019
- **Spec refs:** `SPECIFICATION.md` [§19. Deferred Decisions and ADRs](SPECIFICATION.md#19-deferred-decisions-and-adrs)
- **Scope:** Document and enforce, via a documented review gate, that any learner-invented "encoding" or "cipher" from `ALD-069`'s research (or any other emergent scheme) is never substituted for the production signing/hashing mechanisms in `ALD-009`/`ALD-019` — novelty in a research harness must never be mistaken for or promoted to a security mechanism.
- **Acceptance criteria:**
  - [ ] A written policy statement exists distinguishing "research-harness encoding" from "production cryptographic signing," citing `ALD-009` and `ALD-019` as the only production mechanisms.
  - [ ] A code-level check (e.g., module boundary or lint rule) prevents any `ALD-069`-harness-derived code from being imported into the `ALD-009`/`ALD-019` signing modules.
  - [ ] This policy is included in the documentation set (`ALD-079`) and referenced by `E40`'s readiness gate (`ALD-077`).

### EPIC-14 — Experiment Pre-Registration and E00–E50 Readiness Gates

**Goal:** implement pre-registration binding and the intervention/baseline test scaffold, and define the five readiness gates covering all 19 experiments. **Depends on:** EPIC-05, EPIC-06, EPIC-08, EPIC-13. **Acceptance gate:** Gates G1–G5 all pass. **Note:** items in this epic build software readiness checks; they do not run experiments, interpret results, or draw scientific conclusions — that work stays in `EXPERIMENT-NOTEBOOK.md` as research execution.

#### ALD-071 — Pre-registration binding and Experiment Record writer
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-023, ALD-002, ALD-016
- **Spec refs:** `SPECIFICATION.md` [§15.1 Pre-Registration Binding](SPECIFICATION.md#151-pre-registration-binding), `EXPERIMENT-NOTEBOOK.md` [§4. Study Metadata](EXPERIMENT-NOTEBOOK.md#4-study-metadata)
- **Scope:** Bind a notebook experiment and sealed hypothesis/parameters to RunConfig, create append-only versioned Experiment Records, and export `experiment-record.json` with disposition/checkpoint/anchor/verifier/deviation references.
- **Acceptance criteria:**
  - [ ] A run cannot start without a bound experiment ID, protocol commit, and canonical pre-registration hash, which cannot be altered.
  - [ ] Pre-registration creates Experiment Record version `1`; later disposition/evidence changes append higher versions without updating prior rows.
  - [ ] Every evidence bundle contains the latest record plus its version history and references resolvable by an independent reviewer.

#### ALD-072 — Intervention test suite and baseline/statistics scaffold
- **Priority:** P1 · **Size:** L · **Class:** MVP · **Depends on:** ALD-041, ALD-071
- **Spec refs:** `SPECIFICATION.md` [§15.2 Intervention Test Suite](SPECIFICATION.md#152-intervention-test-suite), [§15.3 Evaluation Baselines and Statistics](SPECIFICATION.md#153-evaluation-baselines-and-statistics)
- **Scope:** Build the software scaffold (not the scientific analysis itself) that lets a pre-registered intervention be applied to a deterministic scenario run (`ALD-041`) and that computes the baseline statistics named in §15.3 over run output.
- **Acceptance criteria:**
  - [ ] An intervention defined in a pre-registration reference (`ALD-071`) can be toggled on/off for a run via configuration, with no code change per intervention.
  - [ ] The scaffold computes every baseline statistic named in §15.3 over a completed run's evidence.
  - [ ] The scaffold's output is a data structure ready for a researcher's downstream analysis — it does not itself draw or store scientific conclusions.

#### ALD-073 — Gate G1: Integrity and isolation readiness (E00–E03)
- **Priority:** P0 · **Size:** S · **Class:** MVP · **Depends on:** ALD-015, ALD-021, ALD-029, ALD-035, ALD-036, ALD-041, ALD-042, ALD-067, ALD-068, ALD-071, ALD-072
- **Spec refs:** `SPECIFICATION.md` [§17.4 Traceability to E00–E50](SPECIFICATION.md#174-traceability-to-e00-e50), `EXPERIMENT-NOTEBOOK.md` [E00](EXPERIMENT-NOTEBOOK.md#e00-ledger-integrity-and-base-anchoring), [E01](EXPERIMENT-NOTEBOOK.md#e01-channel-isolation-and-side-channel-red-team), [E02](EXPERIMENT-NOTEBOOK.md#e02-observation-and-metadata-leakage-audit), [E03](EXPERIMENT-NOTEBOOK.md#e03-chance-no-communication-and-random-message-controls)
- **Scope:** Define and check the readiness gate confirming the software capability required for `E00`–`E03` exists and passes its own conformance checks — the gate asserts *capability is ready to run the experiment*, not that the experiment has been run or what it found.
- **Acceptance criteria:**
  - [ ] `E00` readiness: the verifier accepts an unchanged anchored bundle and rejects all 14 mutation/anchor cases in LEDGER §17, including wrong-chain anchors and unanchored tails.
  - [ ] `E01`/`E02` readiness: `ALD-067`/`ALD-068` red-team suites are green.
  - [ ] `E03` readiness: `ALD-029`/`ALD-036` run all six controls with dual-hash evidence, while `ALD-041`/`ALD-042`/`ALD-072` provide deterministic scenarios, no-learning behavior, confidence intervals, and effect sizes.

#### ALD-074 — Gate G2: Model-track and protocol readiness (E10–E16)
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-031, ALD-032, ALD-036, ALD-042, ALD-044, ALD-045, ALD-046, ALD-047, ALD-056, ALD-057, ALD-064, ALD-072
- **Spec refs:** `SPECIFICATION.md` [§17.4 Traceability to E00–E50](SPECIFICATION.md#174-traceability-to-e00-e50), `EXPERIMENT-NOTEBOOK.md` [E10](EXPERIMENT-NOTEBOOK.md#e10-frozen-pretrained-llm-protocol-baseline), [E11](EXPERIMENT-NOTEBOOK.md#e11-from-scratch-rl-naming-game), [E12](EXPERIMENT-NOTEBOOK.md#e12-self-supervised-ungrounded-baseline), [E13](EXPERIMENT-NOTEBOOK.md#e13-no-predefined-symbol-library), [E14](EXPERIMENT-NOTEBOOK.md#e14-turn-taking-role-reversal-and-repair), [E15](EXPERIMENT-NOTEBOOK.md#e15-composition-and-held-out-generalization), [E16](EXPERIMENT-NOTEBOOK.md#e16-causal-listening-and-ledger-validity)
- **Scope:** Define and check the readiness gate confirming every model track and protocol capability that `E10`–`E16` require exists and passes conformance, across all seven experiments in this range.
- **Acceptance criteria:**
  - [ ] `E10`/`E11`/`E12` readiness: `ALD-044`/`ALD-045`/`ALD-046` complete full turns; ungrounded tracks pass training isolation and semantic-leakage qualification.
  - [ ] `E13` readiness: all `ALD-031` alternate carriers pass conformance and `ALD-032` leakage evaluation can compare all five notebook carrier conditions.
  - [ ] `E14`/`E15`/`E16` readiness: `ALD-072` supports role reversal, held-out splits, and causal interventions, and `ALD-064` produces separately labeled human audit interpretations.

#### ALD-075 — Gate G3: Affect and learning-comparison readiness (E20–E22)
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-023, ALD-033, ALD-042, ALD-044, ALD-045, ALD-046, ALD-072
- **Spec refs:** `SPECIFICATION.md` [§17.4 Traceability to E00–E50](SPECIFICATION.md#174-traceability-to-e00-e50), `EXPERIMENT-NOTEBOOK.md` [E20](EXPERIMENT-NOTEBOOK.md#e20-constrained-affect-channel-study), [E21](EXPERIMENT-NOTEBOOK.md#e21-rl-versus-non-rl-learning-comparison), [E22](EXPERIMENT-NOTEBOOK.md#e22-developmental-plasticity-and-curriculum)
- **Scope:** Define and check the readiness gate confirming the six-display affect channel and the RL/non-RL comparison capability required for `E20`–`E22` exist and pass conformance.
- **Acceptance criteria:**
  - [ ] `E20` readiness: `ALD-033` affect protocol independently passes conformance with all six displays exercised.
  - [ ] `E21` readiness: no-learning (`ALD-042`), frozen-LLM (`ALD-044`), extrinsic/intrinsic scratch-RL (`ALD-045`), and self-supervised (`ALD-046`) modes run under the same scenario configuration.
  - [ ] `E22` readiness: `ALD-072`'s scaffold supports a staged/curriculum sequence of interventions within a single run.

#### ALD-076 — Gate G4: Transfer and negotiation-scenario readiness (E30–E32)
- **Priority:** P2 · **Size:** S · **Class:** Later-Research · **Depends on:** ALD-028, ALD-041, ALD-072
- **Spec refs:** `SPECIFICATION.md` [§17.4 Traceability to E00–E50](SPECIFICATION.md#174-traceability-to-e00-e50), `EXPERIMENT-NOTEBOOK.md` [E30](EXPERIMENT-NOTEBOOK.md#e30-partner-replacement-and-zero-shot-transfer), [E31](EXPERIMENT-NOTEBOOK.md#e31-longitudinal-drift-and-stability), [E32](EXPERIMENT-NOTEBOOK.md#e32-cooperative-signaling-versus-negotiation)
- **Scope:** Define and check the readiness gate confirming derived-run support, deterministic long-run analysis, and the Scenario Engine's aligned/private/semi-cooperative/conflicting utility configurations are sufficient for partner-replacement, longitudinal, and negotiation experiments.
- **Acceptance criteria:**
  - [ ] `E30` readiness: `ALD-028` derived-run support can substitute a new learner adapter in the child run without altering the parent.
  - [ ] `E31` readiness: `ALD-072`'s baseline/statistics scaffold can compare metrics across a long sequence of turns/checkpoints for drift analysis.
  - [ ] `E32` readiness: `ALD-041` produces each pre-registered cooperative and negotiation utility condition from configuration without a code change.

#### ALD-077 — Gate G5: Cryptography-research and replication readiness (E40, E50)
- **Priority:** P2 · **Size:** S · **Class:** Later-Research · **Depends on:** ALD-069, ALD-070, ALD-028, ALD-072
- **Spec refs:** `SPECIFICATION.md` [§17.4 Traceability to E00–E50](SPECIFICATION.md#174-traceability-to-e00-e50), `EXPERIMENT-NOTEBOOK.md` [E40](EXPERIMENT-NOTEBOOK.md#e40-ephemeral-encoding-and-adversarial-cryptography), [E50](EXPERIMENT-NOTEBOOK.md#e50-multi-seed-replication-and-study-closeout), [§12. Publication Checklist](EXPERIMENT-NOTEBOOK.md#12-publication-checklist)
- **Scope:** Define and check the readiness gate confirming the cryptography research harness and its safety-separation policy are in place for `E40`, and that multi-seed replication tooling is ready for `E50`.
- **Acceptance criteria:**
  - [ ] `E40` readiness: `ALD-069` harness and `ALD-070` separation policy both pass their own acceptance criteria.
  - [ ] `E50` readiness: `ALD-028` derived-run support and `ALD-072`'s scaffold together launch the same pre-registered configuration across independent seeds and aggregate baseline statistics.
  - [ ] This gate's checklist cross-references the `EXPERIMENT-NOTEBOOK.md` [§12. Publication Checklist](EXPERIMENT-NOTEBOOK.md#12-publication-checklist) items that are software-verifiable, without asserting any of the checklist's research-judgment items are satisfied.

### EPIC-15 — CI/Test Suites, Documentation, Operations, and Release

**Goal:** consolidate all test suites into CI, produce the documentation set, and define the release/publication mapping. **Depends on:** all prior epics. **Acceptance gate:** CI green on consolidated suite; docs and release mapping complete.

#### ALD-078 — CI pipeline and consolidated test suite
- **Priority:** P0 · **Size:** L · **Class:** MVP · **Depends on:** ALD-011, ALD-036, ALD-057, ALD-067, ALD-068
- **Spec refs:** `SPECIFICATION.md` [§17.2 Test Strategy](SPECIFICATION.md#172-test-strategy)
- **Scope:** Stand up a CI pipeline running, on every change: the crash-safety suite (`ALD-011`), the Gateway conformance suite (`ALD-036`), the semantic-leakage battery (`ALD-057`), and both red-team suites (`ALD-067`/`068`), plus every other item's own acceptance tests referenced elsewhere in this backlog.
- **Acceptance criteria:**
  - [ ] CI runs on every proposed change and blocks merge on any failing suite.
  - [ ] The consolidated suite includes at least one test per `Done` item's acceptance criteria at the time CI is stood up.
  - [ ] CI run time and flakiness are tracked; a flaky test is quarantined with a tracked follow-up, not silently ignored.

#### ALD-079 — Architecture/API/operations documentation set
- **Priority:** P1 · **Size:** M · **Class:** MVP · **Depends on:** ALD-048, ALD-049, ALD-050, ALD-055, ALD-060
- **Spec refs:** `SPECIFICATION.md` [§1.5 Relationship to Companion Documents](SPECIFICATION.md#15-relationship-to-companion-documents)
- **Scope:** Write the documentation set covering: architecture overview, full API reference (all routes from EPIC-09), Mode R operational runbook (container isolation, `ALD-055`), and the snapshot/restore/recovery runbook (`ALD-060`).
- **Acceptance criteria:**
  - [ ] Every route implemented in EPIC-09 has a corresponding API reference entry with request/response shape.
  - [ ] The Mode R runbook lets an operator who has not read the source code stand up an isolated run following the documented steps alone.
  - [ ] The snapshot/restore runbook is validated by having someone other than the implementer follow it to perform a real restore.

#### ALD-080 — Release process and publication-checklist mapping
- **Priority:** P1 · **Size:** S · **Class:** MVP · **Depends on:** ALD-071, ALD-077, ALD-079
- **Spec refs:** `EXPERIMENT-NOTEBOOK.md` [§12. Publication Checklist](EXPERIMENT-NOTEBOOK.md#12-publication-checklist)
- **Scope:** Define the release process for the software (versioning, tagging, changelog) and produce a mapping from each `EXPERIMENT-NOTEBOOK.md` §12 publication-checklist item to the specific backlog item(s)/gate(s) that make it achievable, without claiming any research-judgment checklist item as satisfied by software alone.
- **Acceptance criteria:**
  - [ ] A documented release process exists (version scheme, changelog convention, tagging) consistent with §1's normative-language conventions.
  - [ ] Every software-verifiable item in the §12 publication checklist is mapped to at least one `ALD-XXX` ID or Gate (`ALD-073`–`077`).
  - [ ] The mapping explicitly flags which §12 checklist items are research-judgment calls outside this backlog's scope (e.g., "results support the stated hypothesis"), rather than silently omitting them.

## 13. Experiment Readiness Gate Mapping

This table maps every experiment in `EXPERIMENT-NOTEBOOK.md` §7–§8 to the readiness gate (and underlying backlog items) that must be `Done` before the experiment can be executed. **A passing gate means the software capability exists and conforms to spec — it is not a claim about the experiment's scientific outcome.** Running the experiment, analyzing data, and drawing conclusions remain research-execution activities in `EXPERIMENT-NOTEBOOK.md`, outside this backlog's scope.

| Experiment | Gate | Gate Item | Underlying Readiness Items |
|---|---|---|---|
| [E00](EXPERIMENT-NOTEBOOK.md#e00-ledger-integrity-and-base-anchoring) | G1 | ALD-073 | ALD-015, ALD-021 |
| [E01](EXPERIMENT-NOTEBOOK.md#e01-channel-isolation-and-side-channel-red-team) | G1 | ALD-073 | ALD-067 |
| [E02](EXPERIMENT-NOTEBOOK.md#e02-observation-and-metadata-leakage-audit) | G1 | ALD-073 | ALD-038, ALD-039, ALD-068 |
| [E03](EXPERIMENT-NOTEBOOK.md#e03-chance-no-communication-and-random-message-controls) | G1 | ALD-073 | ALD-029, ALD-035, ALD-036, ALD-041, ALD-042, ALD-072 |
| [E10](EXPERIMENT-NOTEBOOK.md#e10-frozen-pretrained-llm-protocol-baseline) | G2 | ALD-074 | ALD-044, ALD-036 |
| [E11](EXPERIMENT-NOTEBOOK.md#e11-from-scratch-rl-naming-game) | G2 | ALD-074 | ALD-045, ALD-056, ALD-057, ALD-036 |
| [E12](EXPERIMENT-NOTEBOOK.md#e12-self-supervised-ungrounded-baseline) | G2 | ALD-074 | ALD-046, ALD-056, ALD-057, ALD-036 |
| [E13](EXPERIMENT-NOTEBOOK.md#e13-no-predefined-symbol-library) | G2 | ALD-074 | ALD-031, ALD-032, ALD-036 |
| [E14](EXPERIMENT-NOTEBOOK.md#e14-turn-taking-role-reversal-and-repair) | G2 | ALD-074 | ALD-072 |
| [E15](EXPERIMENT-NOTEBOOK.md#e15-composition-and-held-out-generalization) | G2 | ALD-074 | ALD-072 |
| [E16](EXPERIMENT-NOTEBOOK.md#e16-causal-listening-and-ledger-validity) | G2 | ALD-074 | ALD-064, ALD-072, ALD-015 |
| [E20](EXPERIMENT-NOTEBOOK.md#e20-constrained-affect-channel-study) | G3 | ALD-075 | ALD-033 |
| [E21](EXPERIMENT-NOTEBOOK.md#e21-rl-versus-non-rl-learning-comparison) | G3 | ALD-075 | ALD-042, ALD-044, ALD-045, ALD-046 |
| [E22](EXPERIMENT-NOTEBOOK.md#e22-developmental-plasticity-and-curriculum) | G3 | ALD-075 | ALD-072 |
| [E30](EXPERIMENT-NOTEBOOK.md#e30-partner-replacement-and-zero-shot-transfer) | G4 | ALD-076 | ALD-028 |
| [E31](EXPERIMENT-NOTEBOOK.md#e31-longitudinal-drift-and-stability) | G4 | ALD-076 | ALD-072 |
| [E32](EXPERIMENT-NOTEBOOK.md#e32-cooperative-signaling-versus-negotiation) | G4 | ALD-076 | ALD-041 |
| [E40](EXPERIMENT-NOTEBOOK.md#e40-ephemeral-encoding-and-adversarial-cryptography) | G5 | ALD-077 | ALD-069, ALD-070 |
| [E50](EXPERIMENT-NOTEBOOK.md#e50-multi-seed-replication-and-study-closeout) | G5 | ALD-077 | ALD-028, ALD-072 |

**Gate ordering:** G1 → G2 → G3 → G4 → G5 is required only where a later gate's underlying items depend on an earlier gate's items (e.g., G2's `ALD-036` depends transitively on G1's `ALD-015`-adjacent lifecycle work). Gates do not need to be executed in strict experiment-numeric order beyond what their item dependencies already require.

## 14. Requirements Coverage Matrix

Every top-level `SPECIFICATION.md` section maps to at least one backlog item. Sections that are purely definitional (no independently implementable capability) map to the items that most directly operationalize them, noted as such.

| SPECIFICATION.md Section | Backlog Item(s) |
|---|---|
| [§1. Purpose and Scope](SPECIFICATION.md#1-purpose-and-scope) | ALD-001 (foundational scope decisions only; not independently implementable) |
| [§2. Normative Language and Conformance](SPECIFICATION.md#2-normative-language-and-conformance) | ALD-078 (conformance enforced via CI) |
| [§3. Terminology](SPECIFICATION.md#3-terminology) | ALD-002 (terminology operationalized as shared types) |
| [§4. Architecture Overview](SPECIFICATION.md#4-architecture-overview) | ALD-001, ALD-004, ALD-010, ALD-029 |
| [§5. Deployment Modes and Claim Boundaries](SPECIFICATION.md#5-deployment-modes-and-claim-boundaries) | ALD-053, ALD-054, ALD-055 |
| [§6. Model Tracks and Learner Contract](SPECIFICATION.md#6-model-tracks-and-learner-contract) | ALD-042, ALD-043, ALD-044, ALD-045, ALD-046, ALD-047, ALD-057 |
| [§7. Run Lifecycle and State Machine](SPECIFICATION.md#7-run-lifecycle-and-state-machine) | ALD-024, ALD-026, ALD-027, ALD-028 |
| [§8. Turn Lifecycle and Atomic Transactions](SPECIFICATION.md#8-turn-lifecycle-and-atomic-transactions) | ALD-010, ALD-025 |
| [§9. Communication Protocols](SPECIFICATION.md#9-communication-protocols) | ALD-029, ALD-030, ALD-031, ALD-032, ALD-033, ALD-034, ALD-035, ALD-036 |
| [§10. Observation Hygiene and Isolation Controls](SPECIFICATION.md#10-observation-hygiene-and-isolation-controls) | ALD-038, ALD-039, ALD-040, ALD-056, ALD-067, ALD-068 |
| [§11. Data Schemas and Interfaces](SPECIFICATION.md#11-data-schemas-and-interfaces) | ALD-002, ALD-018, ALD-023, ALD-035, ALD-037 |
| [§12. DTSF API Surface](SPECIFICATION.md#12-dtsf-api-surface) | ALD-004, ALD-010, ALD-048, ALD-049, ALD-050, ALD-051, ALD-052 |
| [§13. Storage and Evidence Integrity](SPECIFICATION.md#13-storage-and-evidence-integrity) | ALD-005, ALD-006, ALD-007, ALD-008, ALD-009, ALD-012, ALD-013, ALD-016, ALD-018, ALD-019, ALD-020, ALD-021, ALD-022, ALD-064 |
| [§14. Telemetry, Audit, Reproducibility, Snapshot/Restore, Failure Handling, Retention](SPECIFICATION.md#14-telemetry-audit-reproducibility-snapshotrestore-failure-handling-retention) | ALD-058, ALD-059, ALD-060, ALD-061, ALD-062, ALD-066 |
| [§15. Research Workflow Integration](SPECIFICATION.md#15-research-workflow-integration) | ALD-041, ALD-071, ALD-072 |
| [§16. UX Requirements](SPECIFICATION.md#16-ux-requirements) | ALD-063, ALD-065, ALD-066 |
| [§17. Acceptance Criteria and Test Strategy](SPECIFICATION.md#17-acceptance-criteria-and-test-strategy) | ALD-036, ALD-073, ALD-074, ALD-075, ALD-076, ALD-077, ALD-078 |
| [§18. Experiment Variable Registry](SPECIFICATION.md#18-experiment-variable-registry) | ALD-023, ALD-041, ALD-071 |
| [§19. Deferred Decisions and ADRs](SPECIFICATION.md#19-deferred-decisions-and-adrs) | ALD-070, §15 of this backlog (decisions log) |
| [§20. Traceability Resolution of the 29 Concept Questions](SPECIFICATION.md#20-traceability-resolution-of-the-29-concept-questions) | ALD-080 (documentation cross-link only; §20 is itself a traceability index, not an implementable requirement) |

## 15. Decisions and Assumptions

These are working decisions this backlog encodes. Where a decision is not yet made in the source documents, it is marked accordingly rather than invented.

- **Runtime/language:** Node.js + TypeScript, npm workspaces monorepo (ALD-001). No calendar dates or staffing levels are assumed anywhere in this backlog; all sequencing is dependency-based.
- **Evidence store:** SQLite in WAL mode is the sole authoritative local store (ALD-005), per `LEDGER-INTEGRITY-DESIGN.md` [§18. Recommended Initial Decision](LEDGER-INTEGRITY-DESIGN.md#18-recommended-initial-decision). No external database is introduced by this backlog.
- **Anchoring:** Base Sepolia is the default and only unconditional anchoring target (ALD-020); mainnet anchoring exists only as an explicit, separately-configured opt-in (ALD-022), never a default.
- **Model default:** `scratch-rl` (ALD-045) is the primary scientific baseline; the local open-weight `frozen-llm` adapter (ALD-044) is the orchestration-validation default. `no-learning` (ALD-042), `self-supervised` (ALD-046), and `hybrid` (ALD-047) are explicit selections.
- **Isolation:** Mode R uses separate containers/processes per learner with no shared mutable state (ALD-055); Mode P has no such isolation guarantee and must never be labeled with a Mode-R-only claim (ALD-054).
- **On-chain privacy:** only checkpoint root hashes and minimal metadata are ever placed on-chain (ALD-018, ALD-020); no raw observation, model, or private data is anchored, per `SPECIFICATION.md` [§13.6](SPECIFICATION.md#136-privacy-controls) and `LEDGER-INTEGRITY-DESIGN.md` [§12](LEDGER-INTEGRITY-DESIGN.md#12-privacy).
- **Research vs. software boundary:** this backlog treats every `E00`–`E50` experiment as something the software must make *executable*, never as a task this backlog itself completes. EPIC-14's gates check capability readiness only (§13 of this document is explicit about this).
- **Cryptography research boundary:** `ALD-069`'s ephemeral-encoding harness is explicitly research instrumentation; `ALD-070` enforces that its output is never substituted for the production integrity mechanisms in EPIC-02/EPIC-04.
- **Sizing/priority are relative, not calendar-based:** S/M/L reflect complexity, not effort-days; P0/P1/P2 reflect blast radius on integrity/critical-path/research-readiness, not business value.
- **Open/undecided (not invented here):** the specific open-weight frozen-LLM model, exact retention durations for §14.6, and exact confirmation-depth thresholds for §13.4 are left to be filled in when their owning item (ALD-044, ALD-062, ALD-021 respectively) is picked up, using whatever value the source documents specify at that time — this backlog does not invent them.

## 16. Appendix: ID Index

| ID | Title | Epic |
|---|---|---|
| ALD-001 | npm workspaces monorepo bootstrap | EPIC-01 |
| ALD-002 | Shared `@ald/types` schema package | EPIC-01 |
| ALD-003 | Environment, configuration, and secrets convention | EPIC-01 |
| ALD-004 | DTSF twin pack scaffolding (baby-a, baby-b, nursery) | EPIC-01 |
| ALD-005 | SQLite schema migration and WAL mode | EPIC-02 |
| ALD-006 | Canonical ledger event serializer | EPIC-02 |
| ALD-007 | Event type registry and validators | EPIC-02 |
| ALD-008 | Hash chaining of ledger and channel events | EPIC-02 |
| ALD-009 | Per-run event and witness key provisioning | EPIC-02 |
| ALD-010 | Evidence Writer and atomic turn transaction | EPIC-02 |
| ALD-011 | WAL durability and crash-safety tests | EPIC-02 |
| ALD-012 | Ordered Merkle trees and consistency proofs | EPIC-03 |
| ALD-013 | Checkpoint manifest generation | EPIC-03 |
| ALD-014 | Checkpoint frequency scheduler | EPIC-03 |
| ALD-015 | Independent verifier CLI | EPIC-03 |
| ALD-016 | Evidence bundle export | EPIC-03 |
| ALD-017 | Verification report schema and generator | EPIC-03 |
| ALD-018 | Anchor receipt schema and storage | EPIC-04 |
| ALD-019 | Anchoring signer key management | EPIC-04 |
| ALD-020 | Base Sepolia anchoring client | EPIC-04 |
| ALD-021 | Anchor confirmation and retry/backoff | EPIC-04 |
| ALD-022 | Mainnet anchoring policy switch | EPIC-04 |
| ALD-023 | Run configuration schema and validation | EPIC-05 |
| ALD-024 | Run state machine | EPIC-05 |
| ALD-025 | Turn phase orchestrator | EPIC-05 |
| ALD-026 | Pause/abort handling | EPIC-05 |
| ALD-027 | Crash recovery and integrity-fork detection | EPIC-05 |
| ALD-028 | Derived-run branching and lineage | EPIC-05 |
| ALD-029 | Symbol Gateway core router and validator | EPIC-06 |
| ALD-030 | Fixed-token protocol | EPIC-06 |
| ALD-031 | Alternate neutral carrier protocols | EPIC-06 |
| ALD-032 | Alternate-carrier leakage evaluation | EPIC-06 |
| ALD-033 | Six-display affect protocol | EPIC-06 |
| ALD-034 | Channel violation detection and rejection behavior | EPIC-06 |
| ALD-035 | Turn envelope, channel event, and ledger draft schemas | EPIC-06 |
| ALD-036 | Gateway/protocol conformance test suite | EPIC-06 |
| ALD-037 | Observation schema and builder | EPIC-07 |
| ALD-038 | Observation hygiene filter | EPIC-07 |
| ALD-039 | OCR detection and scenario-bundle quarantine | EPIC-07 |
| ALD-040 | Side-channel elimination in transport layer | EPIC-07 |
| ALD-041 | Deterministic scenario/task engine | EPIC-07 |
| ALD-042 | Learner Adapter interface | EPIC-08 |
| ALD-043 | Learner contract versioning, lint, and tool-only enforcement | EPIC-08 |
| ALD-044 | Frozen-LLM adapter with local open-weight default | EPIC-08 |
| ALD-045 | From-scratch RL learner track | EPIC-08 |
| ALD-046 | Self-supervised ungrounded learner track | EPIC-08 |
| ALD-047 | Hybrid learner track | EPIC-08 |
| ALD-048 | baby-a / baby-b twin pack implementation | EPIC-09 |
| ALD-049 | Nursery controller twin pack | EPIC-09 |
| ALD-050 | Evidence and verification routes on nursery | EPIC-09 |
| ALD-051 | Authorization roles and route guards | EPIC-09 |
| ALD-052 | Response and error shape standardization | EPIC-09 |
| ALD-053 | Mode P / Mode R deployment switch | EPIC-10 |
| ALD-054 | Claim-boundary enforcement | EPIC-10 |
| ALD-055 | Separate-container isolation for Mode R | EPIC-10 |
| ALD-056 | Training isolation guarantees | EPIC-10 |
| ALD-057 | Semantic-leakage test battery automation | EPIC-10 |
| ALD-058 | Telemetry event pipeline | EPIC-11 |
| ALD-059 | Audit, intervention, and safety-event logging | EPIC-11 |
| ALD-060 | Snapshot and restore mechanism | EPIC-11 |
| ALD-061 | Failure handling policy implementation | EPIC-11 |
| ALD-062 | Retention policy enforcement job | EPIC-11 |
| ALD-063 | Dashboard/research console MVP | EPIC-12 |
| ALD-064 | Human audit-ledger Interpreter | EPIC-12 |
| ALD-065 | Prohibited UX pattern review checklist | EPIC-12 |
| ALD-066 | Automated replay fidelity and viewer | EPIC-12 |
| ALD-067 | Side-channel red-team harness | EPIC-13 |
| ALD-068 | Observation-text and quarantine-bypass red-team suite | EPIC-13 |
| ALD-069 | Ephemeral encoding and adversarial cryptography research harness | EPIC-13 |
| ALD-070 | Cryptographic novelty-vs-security separation policy | EPIC-13 |
| ALD-071 | Pre-registration binding and Experiment Record writer | EPIC-14 |
| ALD-072 | Intervention test suite and baseline/statistics scaffold | EPIC-14 |
| ALD-073 | Gate G1: Integrity and isolation readiness (E00–E03) | EPIC-14 |
| ALD-074 | Gate G2: Model-track and protocol readiness (E10–E16) | EPIC-14 |
| ALD-075 | Gate G3: Affect and learning-comparison readiness (E20–E22) | EPIC-14 |
| ALD-076 | Gate G4: Transfer and negotiation-scenario readiness (E30–E32) | EPIC-14 |
| ALD-077 | Gate G5: Cryptography-research and replication readiness (E40, E50) | EPIC-14 |
| ALD-078 | CI pipeline and consolidated test suite | EPIC-15 |
| ALD-079 | Architecture/API/operations documentation set | EPIC-15 |
| ALD-080 | Release process and publication-checklist mapping | EPIC-15 |
