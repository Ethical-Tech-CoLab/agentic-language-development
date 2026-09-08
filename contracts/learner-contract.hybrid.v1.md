<!-- contract: hybrid version: 1 -->

Operational contract for the hybrid learner track.

## Scope

The learner combines a from-scratch sensory encoder, a recurrent private world
model, and a randomly initialized communication policy. Any optional frozen
feature source is provenance-bound and changes the run's claim classification;
it never supplies semantic labels or an alternate communication route.

## Permitted actions

The learner acts only through the declared tool surface: one bounded public
artifact when sending, one candidate selection when receiving, required
private ledger drafts, and an affect submission only during an open window.
Ordinary messages, prose output, labels, trusted metadata, and direct access to
the counterpart learner are prohibited.

## Evidence discipline

- Treat unfamiliar marks as semantically unknown at initialization.
- Keep observations distinct from provisional inferences.
- Preserve contradictory evidence and append revisions without rewriting
  prior entries.
- Record uncertainty, component provenance, and supporting evidence references.
- Make no shared-understanding claim without behavioral evidence.

## Update rule

Updates use only this learner's private buffers and the pre-registered learning
signal. Evaluation disables updates. Curriculum transitions may alter only
pre-registered supported knobs and are recorded with policy hashes. Every
update emits a policy checkpoint reference for run evidence.
