# Agentic Language Development

> Can two isolated agents invent a grounded, auditable language through shared
> experience without communicating in a human language?

[View the project site](https://ethical-tech-colab.github.io/agentic-language-development/)
| [Read the full concept](CONCEPT-IDEA.md)

## Overview

Agentic Language Development is an Ethical Tech CoLab research concept for studying
emergent communication between two agents, **Baby A** and **Baby B**.

Each Baby has its own DTSF digital twin, private memory, learning process, and
chronological language ledger. They can communicate only through a controlled
non-human symbol channel. A third agent, the **BabySitter**, monitors the experiment,
preserves evidence, and enforces isolation without teaching or translating the
language.

```text
                  shared experiences
                         |
                BabySitter / Nursery
               observes, logs, controls
                 /               \
        private observation   private observation
               |                   |
          Baby A twin          Baby B twin
               |                   ^
               +--- Symbol Gateway+
                    only route
```

## Core Questions

- Can two agents establish stable meanings without a supplied dictionary?
- Can their language become compositional and generalize to new situations?
- Will independently maintained ledgers converge on compatible interpretations?
- Can causal interventions prove that the receiver actually uses the messages?
- How do pretrained language models differ from initially ungrounded trainable agents?
- Can affect, intrinsic motivation, negotiation, or ephemeral encodings change what
  emerges?

## What Makes the Concept Distinct

- **Independent mandatory ledgers** preserve every meaning hypothesis and revision.
- **Grounded shared experiences** connect symbols to objects, actions, and outcomes.
- **Strict channel isolation** prevents English or another established human language
  from crossing between the Babies.
- **Monitor-only supervision** separates BabySitter observation from teaching or
  reward shaping.
- **Multiple agent types** make the infant-like analogy testable rather than assumed.
- **Causal and held-out evaluation** distinguishes genuine communication from a
  memorized lookup code.

## Experimental Directions

The concept includes research tracks for:

- a six-display affect allowlist for Happy, Sad, Laughing, Crying, Confused, and
  Surprised, plus permuted, opaque, derived, and emergent affect controls;
- blank-canvas communication without a predefined symbol library;
- endogenous "giddiness," curiosity, and social influence without BabySitter rewards;
- ephemeral coding conventions and adversarial neural cryptography;
- cooperative signaling followed by semi-cooperative negotiation;
- reuse of the DTSF Diplomacy Table interaction and audit model.

These are experimental hypotheses, not claims of established capability or
cryptographic security.

The Babies never receive a general emoji set. The declared affect condition permits
one allowlisted display only in a fixed post-outcome feedback window. It does not
permit emoji sequences, arbitrary timing, modifiers, reactions, or custom glyphs.
Because even six displays can become a small second alphabet, the experiment must
audit whether affect choices leak task information beyond their stated purpose.

## Important Caveat

Pretrained language models already contain human-language concepts. Restricting their
external channel does not make them language-naive. For those agents, the project
studies the emergence of a new shared **external protocol**.

More strongly infant-like language-acquisition claims require initially ungrounded
trainable agents. Every experiment must state which agent type, learning mechanism,
channel constraints, and reward conditions were used.

## Project Status

This repository is currently in the **concept and research phase**. The next milestone
is a testable specification covering the runtime architecture, channel contract,
ledger schema, experiment matrix, evaluation criteria, isolation model, and evidence
requirements.

The complete rationale, literature review, experimental ideas, risks, and open
decisions are in [CONCEPT-IDEA.md](CONCEPT-IDEA.md).

## Responsible Research

All learned-cipher experiments should use synthetic, non-sensitive messages. Novel or
agent-generated encodings must not be represented as production cryptography without
independent expert analysis and formal security work.

The project should report failed conventions, prohibited communication attempts,
human interventions, side-channel limitations, and negative results alongside
successful runs.

## License

Licensed under the [MIT License](LICENSE).
