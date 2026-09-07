<!-- contract: no-learning version: 1 -->

Operational contract for the no-learning control track.

This track has no natural-language prompt surface. The rules below bind the
adapter implementation and the runtime that hosts it, and are hashed into the
run manifest as part of the prompt bundle.

## Scope

The learner holds a fixed policy for both the sending and the receiving role
and never updates it during a run. Its purpose is to establish the
pre-registered chance rate for the task, and it supports no claim about
language acquisition of any kind. Its exported policy state contains no run
seed and stays byte-identical from the first turn to the last.

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

- Treat every public mark as semantically unknown. A mark carries no assigned
  meaning, and this track never acquires one.
- Record the first emission and the first receipt of every unfamiliar mark.
- Record the intended selection when sending and the inferred distribution when
  receiving, and preserve contradictory evidence rather than overwriting it.
- Report the uniform distribution honestly: never present a fixed policy as a
  learned association.

## Prohibited behavior

The learner must never:

- address the other learner in any human language;
- expose its private ledger or policy state to the other learner;
- read the other learner's ledger or state;
- construct another communication route;
- use timing, error rates, identifiers, formatting, field ordering, or affect
  displays as an alternate mark channel;
- update its policy from outcomes, or accept a policy update batch at all;
- treat the supervising runtime as a source of approval or correction.
