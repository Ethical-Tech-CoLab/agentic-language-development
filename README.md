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

This repository is in the **verifiable-core implementation phase**. The evidence
integrity spine and the communication MVP from [BACKLOG.md](BACKLOG.md) milestones
M0-M2, plus most of M3's testnet-anchoring path, are implemented and tested:

- `@ald/hashing`, `@ald/merkle`, `@ald/evidence`: domain-separated hashing, RFC 8785
  canonical JSON, per-run Ed25519 signers and key store, hash-chain validation, RFC
  6962 ordered Merkle trees with inclusion and consistency proofs, and the single
  atomic SQLite Evidence Writer with fork detection, recovery, and bundle export.
- `@ald/checkpoint`, `@ald/anchor`, `@ald/verifier`: signed checkpoint manifests and
  proof files, the Base anchor publisher (fake chain and viem transports; no funded
  wallet is configured here), and the standalone `ald-verify` CLI that re-derives
  every hash, signature, root, proof, binding, and anchor from a bundle alone.
- `@ald/lifecycle`, `@ald/scenario`, `@ald/gateway`, `@ald/learners`,
  `@ald/orchestrator`, `@ald/analysis`: the SPEC §7 run state machine; deterministic
  scenarios, hygiene, and a fail-closed run-registration quarantine gate; fixed-token, glyph, bitmap, canvas,
  tone, and six-display affect protocols; no-learning and scratch-RL runtime tracks;
  frozen-LLM, self-supervised, and hybrid adapter conformance foundations; the
  Nursery's end-to-end SPEC §8 turn cycle; and pre-registered analysis primitives.
- `@ald/isolation`, `@ald/ops`, `@ald/interventions`, `@ald/redteam`: fixed-frame
  process transport and learner-host confinement; API telemetry, snapshot/restore,
  and failure supervision; configuration-driven causal probes, repair, held-out,
  curriculum, drift, and statistical scaffolds; and the committed observation-text
  and quarantine-bypass corpus. These are tested foundations, not a completed Mode R
  deployment or a scientific result.
- DTSF twin packs for `baby-a`, `baby-b`, and `nursery` expose the SPEC §12 routes
  with role guards in Prototype Mode.

The qualification harness (`scripts/run-qualification.mjs`) executes E03-style
chance controls and an E11-style naming game through the real pipeline and writes a
report under `reports/qualification/`. Those runs are **non-confirmatory software
qualification in Prototype Mode**: not pre-registered, not anchored, and never
research findings.

The next critical-path work is live causal-probe and repair execution, an active
side-channel harness, and Mode R
container/network isolation, exercising frozen-LLM with real open weights, enforcing
retention, anchoring on Base Sepolia with a funded wallet, and binding an external
pre-registration.

No experiment results are claimed.

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
| [CONFIGURATION.md](CONFIGURATION.md) | Runtime environment variables, key-store layout, and secret handling |
| [docs/evidence-bundle-format.md](docs/evidence-bundle-format.md) | Byte-level evidence bundle contract shared by the exporter, checkpoint service, and verifier |
| [reports/README.md](reports/README.md) | What the qualification reports are and are not |

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

## Running the Platform Locally

```bash
npm ci
npm run check
```

`npm run check` lints, lints the learner contracts, builds every workspace, runs the
test suite, and scans for committed secrets.

Run the Prototype Mode qualification harness and verify a bundle independently:

```bash
npm run build && node scripts/run-qualification.mjs
```

```bash
node packages/verifier/bin/ald-verify.js evidence/qualification/<run-set>/bundles/runs/<run-id> --allow-unanchored
```

Databases and bundles are written under `evidence/`, which is ignored by git; reports
are written under `reports/qualification/`. Without a funded Base Sepolia wallet
every run seals along the SPECIFICATION.md §7.2 unanchored path and is recorded as
`invalid` by construction.

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
