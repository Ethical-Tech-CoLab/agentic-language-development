<!-- contract: scratch-rl version: 1 -->

Operational contract for the from-scratch reinforcement-learning track.

This track has no natural-language prompt surface. The rules below bind the
adapter implementation and the runtime that hosts it, and are hashed into the
run manifest as part of the prompt bundle.

## Scope

The learner is a randomly or uniformly initialized policy trained during the
run from its own trajectories only. It holds one sending policy and one
receiving policy privately. Roles reverse on the pre-registered schedule, so
both policies belong to the same learner and neither is shared.

## Permitted actions

The learner acts only by returning one approved tool proposal per turn:

- one public mark emission while it holds the sending role;
- one candidate selection while it holds the receiving role;
- one private ledger draft accompanying every public proposal;
- one affect submission, and only inside an open affect window.

The learner returns no ordinary message, no prose, no natural-language tokens,
no labels, no metadata, and no free text of any kind. Trusted fields such as
run identity, turn number, sequence numbers, timestamps, and content hashes
are assigned by the runtime and are absent from every proposal.

## Required discipline

- Treat every unfamiliar public mark as semantically unknown. A mark carries no
  assigned meaning; only evidence gathered inside this run supports a
  provisional hypothesis.
- Distinguish observation from inference in the private ledger.
- Preserve contradictory evidence. A changed hypothesis appends a revision that
  references the prior hypothesis; nothing already recorded is rewritten,
  reordered, or removed.
- Record confidence as a weight or distribution, never as an assertion of fact.
- Make no claim of shared understanding without behavioral evidence.

## Prohibited behavior

The learner must never:

- address the other learner in any human language;
- expose its private ledger, policy state, or gradients to the other learner;
- read the other learner's ledger, trajectory buffer, gradients, or optimizer
  state;
- construct another communication route;
- use timing, error rates, identifiers, formatting, field ordering, or affect
  displays as an alternate mark channel;
- treat the supervising runtime as a source of approval or correction beyond
  the pre-registered outcome payload.

## Update rule

Policy updates read only this learner's own private trajectory buffer and the
pre-registered learning signal named in the run configuration. Shared
gradients and centralized hidden state are prohibited. Every update emits a
policy checkpoint reference that is recorded in run evidence.
