# Source Lineage and Requirement-Origin Register

Status: complete for the repository history through `355391f`; external citation
lineage remains a separate literature-verification task.

## Purpose and method

This register identifies where the project's governing constraints first appear
and how later repository documents refine them. It uses commit identifiers,
dates, document roles, and requirement language. Personal attribution is omitted.
The register does not infer authorship from Git metadata and does not treat a later
generated summary as the origin of an earlier requirement.

The review followed the history of the concept, specification, ledger design,
experiment notebook, backlog, and manuscript from their first commits through the
current toolchain candidate. For conflicts, the current precedence is:

1. `SPECIFICATION.md` for implementation and runtime behavior;
2. `LEDGER-INTEGRITY-DESIGN.md` for integrity mechanics;
3. `EXPERIMENT-NOTEBOOK.md` for experimental registration and status;
4. `CONCEPT-IDEA.md` for the research premise;
5. the backlog, manuscript, generated book, reports, and plans as derived surfaces.

Current workspace rules supersede historical operational choices such as package
manager selection. A later implementation does not retroactively change the
classification of historical qualification evidence.

## Lineage epochs

| Date | Commit | Repository event | Lineage interpretation |
|---|---|---|---|
| 2026-08-24 | `7ba4c56` | Initial concept | Establishes the central question: whether independently learning agents can develop a grounded external communication protocol under a controlled channel |
| 2026-08-24 | `6d8fff6` | Affect-channel constraint | Makes affect a bounded, delayed, auditable channel rather than an unrestricted semantic teaching route |
| 2026-08-24 | `ae23c89` | Learning-mechanism comparison | Introduces explicit reinforcement and non-reinforcement comparisons rather than treating all adaptation as one mechanism |
| 2026-08-24 | `c4ca79d` | Capability-constrained agent design | Replaces age simulation with capability restrictions and requires cautious interpretation of pretrained models |
| 2026-08-24 | `490ef05` | Ledger design and experiment notebook | Establishes integrity mechanics, ordered experiment IDs, prerequisites, controls, and research-status tracking |
| 2026-08-27 | `b1f778d` | Specification and backlog | Converts the premise into normative components, trust boundaries, schemas, lifecycle rules, acceptance criteria, and dependency ordering |
| 2026-08-27 | `d81b570` and `0062f36` | Foundation and local integrity core | Begins executable implementation; establishes software evidence, not experimental completion |
| 2026-09-03 | `9e27ee9` | Pre-results manuscript | Consolidates questions, hypotheses, literature leads, methods, and analysis plans before research results exist |
| 2026-09-07 | `6bbe22c` | First qualification corpus | Adds Prototype Mode software runs that are unregistered, unanchored, and invalid for confirmatory inference by construction |
| 2026-09-08 to 2026-09-09 | `3157d4f` through `0a4ba4d` | Phase-E implementation and readiness gates | Adds extension mechanisms, leakage checks, isolation, interventions, attachment lineage, operations, and executable readiness checks |
| 2026-09-09 | `5f22202` through `d1b4eab` | Hosted checks and research-execution preparation | Adds consolidated checks, historical hosted receipts, design simulation, registration compilation, preflight, and frozen-model qualification; experiments remain unstarted |
| 2026-09-11 | `355391f` | Homebrew/pnpm validation migration | Reconciles current workspace tooling, preserves direct dependency versions, and fixes strict dependency-resolution defects discovered by clean execution |

## Requirement-to-origin map

| Requirement family | Earliest controlling source | Later refinement | Current disposition |
|---|---|---|---|
| Independently adapting agents with a shared external protocol | Initial concept, `7ba4c56` | Specification §§4–8 and notebook E10–E50 | Preserved; no completed empirical demonstration |
| Deterministic Gateway as the only communication route | Initial concept, then specification | Isolation and red-team implementations | Implemented and software-qualified in bounded tests; actual full study topology still requires V06/V10 |
| Private observations, memories, optimizers, and native ledgers | Initial concept | Specification trust boundary and Mode R implementation | Software checks pass; full-study deployment evidence remains open |
| Capability restrictions rather than age-role simulation | `c4ca79d` amendment | Learner contracts and manuscript interpretation rules | Preserved; pretrained-model results must remain external-protocol studies |
| Affect must not become semantic instruction | `6d8fff6` amendment | E20 design and leakage gates | Protocol constraint exists; E20 is unexecuted |
| Reinforcement and reward-free mechanisms must be separated | `ae23c89` amendment | E12/E21 and learner contracts | Reference adapters exist; matched recurrent scientific comparison remains open |
| Hash-chained, signed, checkpointed, independently verifiable evidence | Ledger design, `490ef05` | Specification, evidence bundle format, verifier, anchor package | Local integrity core implemented; fresh mutation-matrix qualification and real chain evidence remain open |
| Anchoring is evidence binding, not semantic truth | Ledger design, `490ef05` | Specification claim boundaries and preflight | Preserved; historical runs are unanchored and cannot become confirmatory retrospectively |
| Experiments have ordered prerequisites and explicit status | Experiment notebook, `490ef05` | Backlog gates and registration compiler | All 19 experiments remain `Not started` |
| Human interpretation is delayed external analysis | Concept and notebook | Audit-ledger implementation and manuscript | Implemented as a separate stream; no completed human study evidence |
| Learned encodings are not production cryptography | Concept and ledger design | Cryptographic separation policy and E40 boundary lint | Enforced in software; E40 and external cryptographic review are open |
| Failed, invalid, aborted, and null runs remain accounted for | Ledger design and notebook | Lifecycle, verifier, reports, and analysis plan | Implemented in schemas and qualification artifacts; confirmatory run index does not yet exist |
| Software readiness must not be reported as a research result | Notebook and specification | README, qualification labels, manuscript, and this report | Preserved; historical qualification remains explicitly non-confirmatory |
| Package installation and workspace execution use Homebrew plus pnpm | Current workspace rules | `355391f` migration | Current operational rule; it does not rewrite the historical npm-based environment |

## Unresolved provenance and interpretation limits

- Repository history establishes when text entered this repository, not who first
  originated every scientific idea.
- The 50-item manuscript bibliography and literature claims have not yet completed
  full primary-source verification; they must not be used to assert novelty until
  the source-verification register is complete.
- Several derived documents summarize implementation status. Their statements need
  requirement-level executable evidence; textual agreement alone is insufficient.
- The original premise and constraints are stable, but experimental details may be
  amended only prospectively with a new protocol hash and new run identifiers.
- External governance, registration, chain receipts, and independent-human records
  cannot be reconstructed from repository history and remain authentic external
  prerequisites.
