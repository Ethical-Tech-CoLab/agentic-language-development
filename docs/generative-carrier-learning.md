# Generative Carrier Learning Qualification

Status: software-qualified mechanism; not an E13 result

Implementation: `generative-carrier-learning-v1`

## Claim boundary

This mechanism lets a scratch learner acquire an exact partner-created form,
place a deterministic local modification in its own action bank, later emit
either form through the ordinary Gateway, and preserve that bank in a policy
checkpoint. It does not establish that a useful convention emerged, that a
modified form generalized, or that one carrier improves learning. Those are
E13 empirical questions and remain unstarted.

## Fixed-capacity state transition

Each generative learner starts with a private, seed-derived bank of distinct
valid artifacts. Its action dimension remains constant throughout the run.
Learning replaces slots; it never appends slots.

1. `receive` validates and hashes the delivered Gateway artifact, resolves an
   exact local match when one exists, and stages an unmatched artifact.
2. The staged artifact does not alter exported state. This keeps retries and
   evaluation observations from mutating a frozen policy.
3. `updatePolicy` commits staged training-turn artifacts in turn order. The
   exact partner artifact replaces the next slot with origin `acquired`.
4. When modification is enabled, one deterministic bounded edit replaces the
   following slot with origin `modified` and records the acquired artifact's
   hash as `parentMarkHash`.
5. Later action selection can choose either slot. Emission passes through the
   same carrier proposal and Gateway path as every other action.

Bitmap modification flips one selected cell. Canvas modification moves one
stroke's start-x coordinate on the 16-position grid. Tone modification moves
one pitch to a different one of eight bins. Every operation preserves the
declared grammar and changes the carrier-qualified mark hash.

The feature is opt-in through `acquirePartnerForms` and
`modifyAcquiredForms`; the latter requires the former. Symbolic inventories
remain immutable when these options are present.

## Checkpoint and recovery contract

Tabular scratch checkpoints use policy version 3 and recurrent scratch
checkpoints use policy version 2. Both include:

- carrier and fixed capacity;
- ordered slot number, opaque form ID, mark hash, and complete artifact;
- origin and introduction turn;
- optional parent hash for modified forms; and
- the next deterministic replacement slot.

Restore validates the proposal schema, carrier, capacity, slot order, content
hashes, uniqueness, origin/parent invariant, and the run's canvas stroke cap.
Older policy versions still load with their original initialized bank.

## Capacity accounting

`carrierCapacity` reports two quantities that must not be conflated:

- physical grammar capacity is the exact number of artifacts admitted by the
  Gateway grammar, reported as a decimal integer and in bits; and
- effective message capacity is the log2 size of the learner's fixed action
  bank, including the declared number of marks for symbolic messages.

For a bank of eight forms and one mark per message, every carrier has an
effective capacity of 3 bits even though the physical grammars differ:

| Carrier | Physical grammar |
|---|---:|
| fixed token or fixed glyph | `8` forms |
| bitmap | `2^256` forms |
| canvas, at most 8 strokes | `sum((16^4 * 3)^k, k=1..8)` forms |
| tone | `sum(32^k, k=1..8)` forms |

This prevents a large rendering grammar from being reported as learner model
capacity.

## Deterministic qualification

Run:

```text
pnpm run qualify:generative-carriers --out <report.json> --db <evidence.sqlite> --bundles <bundle-root>
```

The runner executes fixed token, fixed glyph, bitmap, canvas, and tone through
the production runtime with the recurrent scratch learner, real carrier
modules, SQLite evidence writer, checkpoint service, and independent bundle
verifier. It checks:

- all planned turns are accepted through the selected Gateway carrier;
- initial generative banks are disjoint across roles;
- both roles end training with acquired and modified forms;
- policy hashes are constant throughout evaluation;
- capacity values are recorded separately; and
- every exported bundle independently verifies.

The unit qualification additionally checks exact imitation, parent linkage,
all three mutation grammars against the real carrier modules, JSON round-trip
restore, evaluation staging without mutation, immutable symbolic controls,
and full learner-adapter conformance.

The runner deliberately labels its output
`software-qualification-not-experiment-results`. Its prototype-mode runs seal
with the repository's explicit unanchored qualification disposition and are
not eligible for confirmatory inference.
