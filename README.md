# Agentic Language Development

> Can two isolated agents invent a grounded, auditable language through shared
> experience without communicating in a human language?

[View the project site](https://ethical-tech-colab.github.io/agentic-language-development/)
| [Read the full concept](CONCEPT-IDEA.md)
| [Review ledger integrity](LEDGER-INTEGRITY-DESIGN.md)
| [Open the experiment notebook](EXPERIMENT-NOTEBOOK.md)
| [Read the specification](SPECIFICATION.md)
| [Open the backlog](BACKLOG.md)
| [Read the research manuscript](RESEARCH.md)
| [Read the page-turn edition](https://ethical-tech-colab.github.io/agentic-language-development/research-book.html?open=1)

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

- **Independent mandatory ledgers** preserve every meaning hypothesis and revision
  through hash chains, signed Merkle checkpoints, and optional public-chain anchors.
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
- controlled comparisons among frozen LLM memory, extrinsic-reward MARL,
  intrinsic-motivation MARL, self-supervised learning, and a no-learning baseline;
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

This repository is in the **foundation implementation phase**. The npm/TypeScript
workspace, shared runtime schemas, typed configuration loader, secret scan, and three
DTSF-compatible twin-pack skeletons, SQLite WAL evidence schema, RFC 8785 canonical
serialization, and ledger event validators are implemented. The next critical-path
work is independent ledger/channel hash chaining (ALD-008 onward).

No experiment results are claimed yet.

The complete rationale, literature review, experimental ideas, risks, and open
decisions are in [CONCEPT-IDEA.md](CONCEPT-IDEA.md).

## Project Documents

| Document | Purpose |
|---|---|
| [CONCEPT-IDEA.md](CONCEPT-IDEA.md) | Research premise, architecture, literature, safeguards, experiments, and open decisions |
| [LEDGER-INTEGRITY-DESIGN.md](LEDGER-INTEGRITY-DESIGN.md) | Hash-chain, ordered-Merkle, signature, Base-anchor, verifier, and recovery design |
| [EXPERIMENT-NOTEBOOK.md](EXPERIMENT-NOTEBOOK.md) | Ordered experiment protocols, checklists, result tables, deviations, and publication review |
| [SPECIFICATION.md](SPECIFICATION.md) | Normative architecture, protocols, schemas, APIs, isolation controls, lifecycle, and acceptance criteria |
| [BACKLOG.md](BACKLOG.md) | Milestones, critical path, epics, dependency-ordered stories, readiness gates, and requirement coverage |
| [RESEARCH.md](RESEARCH.md) | Pre-results academic manuscript, research questions, methods, literature review, analysis plan, source verification, and arXiv preparation checklist |

## Research Book

The full research manuscript is also published through the Ethical Tech CoLab
`read-as-book` v3 page-turn reader:

**https://ethical-tech-colab.github.io/agentic-language-development/research-book.html?open=1**

The reader uses committed WebP pages generated from [RESEARCH.md](RESEARCH.md), opens
as a two-page spread on desktop, collapses to one page on mobile, and provides the
generated PDF as a download.

Regenerate the book after changing the manuscript:

```powershell
npm run book:research
```

The page rasterizer requires Node.js 22.13 or newer; generated book assets do not
require Node.js in the browser.

Set `CHROME_PATH` if Chrome or Edge is not installed at a standard location. The
generated PDF, page manifest, page images, print edition, and locally bundled reader
are committed so GitHub Pages needs no server, CDN, or runtime PDF renderer.

The notebook is ready for pre-registration. No experiment results are claimed yet.

## Responsible Research

All learned-cipher experiments should use synthetic, non-sensitive messages. Novel or
agent-generated encodings must not be represented as production cryptography without
independent expert analysis and formal security work.

The project should report failed conventions, prohibited communication attempts,
human interventions, side-channel limitations, and negative results alongside
successful runs.

Only hashes and minimal routing metadata should be anchored publicly. Private ledgers,
messages, prompts, identities, and secrets must remain off-chain.

## License

Licensed under the [MIT License](LICENSE).
