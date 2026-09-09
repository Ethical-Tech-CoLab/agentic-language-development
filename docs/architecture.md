# Architecture overview

The system has three twin surfaces: `baby-a`, `baby-b`, and `nursery`. A Baby
receives only a private numeric observation, acts through the Symbol Gateway,
receives only a validated public artifact, and writes only its own native
ledger. There is deliberately no Baby-to-Baby route. The Nursery owns run
lifecycle, deterministic scenarios, evidence export, checkpointing,
verification, operator interventions, and the Research Console.

One committed turn follows this boundary:

1. the Scenario Engine deterministically produces role-specific observations;
2. the active Baby adapter returns a proposal and private intention draft;
3. the Symbol Gateway validates the carrier and commits the public channel
   event plus the sender ledger event atomically through the Evidence Writer;
4. the recipient adapter receives only the committed public artifact and
   returns its interpretation draft;
5. the Nursery evaluates the task outcome and records signed outcome and turn
   evidence; and
6. the Checkpoint Service commits ordered Merkle roots for every evidence
   stream, which the Anchor Publisher may submit to Base.

SQLite WAL and append-only constraints are the local source of truth. Bundle
export is a deterministic projection of that store. The independent verifier
uses only an exported bundle, public keys, and anchor receipts; it does not
trust the live runtime or its database.

Prototype Mode keeps logical state separation in one process. Research-Grade
Mode places the two learner hosts in distinct hardened containers and distinct
internal networks, with the Nursery attached to both networks as the only
test controller. The exact six allowed mode differences are represented by
`MODE_COMPARISON`; all protocol, scenario, evidence, and learner behavior is
otherwise shared.

Operational entry points are documented in [the API reference](api-reference.md),
[the Mode R runbook](mode-r-runbook.md), and
[the snapshot/restore runbook](snapshot-restore-runbook.md).
