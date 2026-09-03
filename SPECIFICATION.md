# Agentic Language Development — Implementation Specification

> **Document type:** Implementation specification
>
> **Status:** Draft, implementation-ready
>
> **Normative for:** All future runtime, protocol, ledger, and evidence work in this
> repository, unless explicitly superseded by a later versioned specification.
>
> **Companion documents:** [CONCEPT-IDEA.md](CONCEPT-IDEA.md) (research premise and
> open questions this document resolves),
> [LEDGER-INTEGRITY-DESIGN.md](LEDGER-INTEGRITY-DESIGN.md) (authoritative for ledger
> hashing, Merkle, checkpoint, and anchoring detail; this document references rather
> than restates that detail where the two would otherwise duplicate), and
> [EXPERIMENT-NOTEBOOK.md](EXPERIMENT-NOTEBOOK.md) (authoritative for experiment
> pre-registration and the E00-E50 research sequence this document must remain
> traceable to).
>
> **Precedence:** Where this document and LEDGER-INTEGRITY-DESIGN.md conflict on
> ledger, checkpoint, Merkle, or anchoring mechanics, LEDGER-INTEGRITY-DESIGN.md
> governs. Where this document and CONCEPT-IDEA.md conflict, this document governs,
> because it exists to resolve CONCEPT-IDEA.md's open questions.

## 1. Purpose and Scope

### 1.1 Purpose

This specification converts the Nursery Lab concept in
[CONCEPT-IDEA.md](CONCEPT-IDEA.md) into a testable system: component boundaries,
trust boundaries, deployment modes, protocols, data schemas, an API surface, an
evidence and integrity model, a research workflow, and acceptance criteria precise
enough to implement and to grade.

### 1.2 Scope

In scope:

- the Baby/Learner A and Baby/Learner B twins and their learner contracts;
- the Nursery Controller/BabySitter twin and the deterministic services it composes
  (Symbol Gateway, Scenario Engine, ledger writers, evidence store, checkpoint
  service, verifier, Base anchor publisher);
- the fixed-token, generative-carrier, and six-display affect protocols;
- the run and turn lifecycle, including pause, abort, recovery, and fork handling;
- normative data schemas for configuration, observations, actions, ledger and
  channel events, checkpoints, anchors, experiment records, and verification
  reports;
- the DTSF API surface exposed by these twins and services;
- storage, evidence-bundle structure, and the cryptographic integrity chain, by
  reference to [LEDGER-INTEGRITY-DESIGN.md](LEDGER-INTEGRITY-DESIGN.md);
- telemetry, audit, reproducibility, retention, and failure handling;
- the research workflow binding this specification to
  [EXPERIMENT-NOTEBOOK.md](EXPERIMENT-NOTEBOOK.md) and the E00-E50 sequence;
- UX requirements for the dashboard/research console, including which parts of the
  Diplomacy Table interaction model are reused;
- acceptance criteria, test strategy, and phased delivery.

Out of scope: a specific choice of RPC provider, cloud host, or wallet-custody
provider (see [Section 19](#19-deferred-decisions-and-adrs)); the final published
research results; and any claim that this design achieves formally verified
security or formally verified cryptography. This document specifies a system that
produces **tamper-evident, anchored evidence**, not one that produces
mathematically proven confidentiality or mathematically proven language
acquisition.

### 1.3 Goals

- Make every architectural, protocol, and default-value decision needed to start
  implementation without inventing behavior ad hoc.
- Resolve each of the 29 questions in CONCEPT-IDEA.md §21, either as a fixed
  decision or as a named, defaulted, configurable experiment variable.
- Keep prototype work possible in a single process while defining exactly what a
  research-grade, isolation-credible deployment additionally requires.
- Keep the specification consistent with the ledger, Merkle, and anchoring design
  already committed in LEDGER-INTEGRITY-DESIGN.md.
- Keep every claim bounded: state what a passing test proves and what it does not
  prove.

### 1.4 Non-Goals

- Re-deriving or re-justifying the hashing, Merkle, checkpoint, or anchoring
  mechanics already specified in LEDGER-INTEGRITY-DESIGN.md.
- Selecting a final production model vendor, weight file, or hosting provider.
- Producing a claim that any implementation of this specification demonstrates
  human infant language acquisition.
- Producing or endorsing production cryptography. Cipher experiments under this
  specification remain research instruments, never security products.
- Specifying the internal training algorithm of any `LearnerAdapter` beyond the
  interface and isolation contract it must satisfy.

### 1.5 Relationship to Companion Documents

CONCEPT-IDEA.md remains the record of research premise, literature review, and
rationale. EXPERIMENT-NOTEBOOK.md remains the record of what was pre-registered,
run, and observed. LEDGER-INTEGRITY-DESIGN.md remains authoritative for the
cryptographic evidence chain. This document is the bridge that a team can actually
build against: it names components, defines wire and storage schemas, and states
default values for every configurable behavior.

## 2. Normative Language and Conformance

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in
this document are to be interpreted as described in RFC 2119. **MUST**/**MUST
NOT** denote requirements whose violation makes a run's evidence or isolation claim
invalid. **SHOULD**/**SHOULD NOT** denote strong defaults that a pre-registered
protocol amendment may override, with the deviation recorded per
EXPERIMENT-NOTEBOOK.md §3 and §9. **MAY** denotes an explicitly permitted
implementation choice.

A component "conforms" to this specification if it satisfies every MUST that
applies to its role. A **run** conforms if every component it used conformed, and
if the run's disposition (valid/invalid/aborted, per §7) was recorded honestly.

## 3. Terminology

| Term | Definition |
|---|---|
| Baby / Learner | The research narrative name is **Baby A** / **Baby B**; the internal, prompt-facing, and code-facing name is **Learner A** / **Learner B**. No persona or age instruction is ever given to a Learner (CONCEPT-IDEA.md §20.1). |
| Nursery Controller | The DTSF twin that owns run orchestration, scenario delivery, human-facing dashboards, and BabySitter audit narration. |
| BabySitter | The supervisory role and behavior of the Nursery Controller twin: monitor-only, no teaching, no translation, no reward shaping. Not a separate twin from the Nursery Controller (resolves Q7). |
| Symbol Gateway | The deterministic, non-model service that is the only permitted Baby-to-Baby message route. It validates, meters, and commits every channel artifact. |
| Scenario Engine | The deterministic, non-model service that generates scenario instances, ground truth, and evaluation held-out sets from a seed and a pre-registered generation config. |
| Model Adapter / `LearnerAdapter` | The process-isolated component that implements a Learner's perception-action-update loop for one model track. |
| Ledger Writer | A per-Baby isolated service that is the only component permitted to sign ledger entries with that Baby's ledger-writer key. |
| Evidence Store | The SQLite (WAL) database and JSONL export pipeline that holds all append-only event tables (LEDGER-INTEGRITY-DESIGN.md §3). |
| Checkpoint Service | The service that builds ordered Merkle trees, signs checkpoint manifests, and hands them to the Base anchor publisher. |
| Verifier | The standalone, independently runnable program that rebuilds and checks the entire evidence chain without trusting the runtime that produced it. |
| Base Anchor Publisher | The service holding the anchor wallet key that submits checkpoint-hash transactions to Base. |
| Dashboard / Research Console | The human-facing UI surface (per-twin dashboards plus a Nursery-wide console) used for configuration, monitoring, and authorized intervention. |
| Run | One complete, uniquely identified execution of a pre-registered experiment configuration from initialization to sealing. |
| Turn | One atomic cycle of observation delivery, a proposal from the acting Baby, gateway validation, ledger commitment, and delivery/outcome. |
| Prototype Mode (Mode P) | A deployment mode with logical isolation only; see §5.1. |
| Research-Grade Mode (Mode R) | A deployment mode with process/container isolation and network-policy enforcement; see §5.2. |
| Fixed-token protocol | Communication drawn only from a pre-registered, meaningless symbol inventory (e.g., `S01`-`S32`). |
| Generative-carrier protocol | Communication drawn from a bounded, neutral production grammar (e.g., a quantized stroke canvas) rather than a supplied inventory. |
| Affect channel | The separate, strictly constrained six-display feedback channel defined in CONCEPT-IDEA.md §19.1 and formalized in §9.3. |
| Agent-native ledger | The Learner's own structured internal-state record (confidences, embeddings, prediction errors). |
| Human-audit ledger | The three-column chronological, human-readable interpretation record, whether Learner-authored (LLM track) or generated by a deterministic Interpreter (ungrounded track). |

## 4. Architecture Overview

### 4.1 Components

```text
                     Human Researcher (dashboard / research console)
                                    |
                                    v
                 +----------------------------------------+
                 |     Nursery Controller / BabySitter      |
                 |  (DTSF twin: orchestration, dashboards,  |
                 |   audit narration, human intervention)   |
                 +---------------------+--------------------+
                                       |
             uses (deterministic, non-model services; not a Baby-reachable API)
                                       |
   +-----------------+-----------------+------------------+-----------------+
   |                 |                 |                  |                 |
   v                 v                 v                  v                 v
Scenario         Symbol           Checkpoint        Evidence Writer    Base Anchor
Engine           Gateway          Service            + Store            Publisher
(deterministic)  (deterministic,  (Merkle build,     JSONL export)     (Base Sepolia
                 only Baby<->Baby  sign manifest)                       / mainnet)
                 route)
                    |    |
        +-----------+    +-----------+
        |                            |
        v                            v
+----------------+           +----------------+
| Baby A twin     |           | Baby B twin     |
| (Learner A      |           | (Learner B      |
|  adapter,       |           |  adapter,       |
|  private state, |           |  private state, |
|  ledger writer  |           |  ledger writer  |
|  A)             |           |  B)             |
+----------------+           +----------------+

                 Verifier (independent, offline; reads only the
                 exported evidence bundle, trusts nothing at runtime)
```

Twin/service inventory:

1. **Baby A twin** and **Baby B twin** — host a `LearnerAdapter`, private
   observation buffer, private memory, and an append-only client to their own
   Ledger Writer. Neither twin has any API, tool, or state reference to the other
   twin (§4.2).
2. **Nursery Controller / BabySitter twin** — a single twin (resolves Q7) that runs
   the run/turn state machine, invokes the Scenario Engine and Symbol Gateway,
   drives dashboards, and performs read-only audit. It MUST NOT expose a route
   that lets one Baby read the other Baby's state, ledger, or observation.
3. **Symbol Gateway** — deterministic; the only network path between Baby A and
   Baby B. Owns validation, metering, atomic commit, and rejection logging for
   fixed-token, generative-carrier, and affect artifacts.
4. **Scenario Engine** — deterministic; generates scenario instances and held-out
   sets from `(seed, scenarioBundleConfig)`. Contains no learned model and no
   model-derived randomness so that scenario generation is independently
   reproducible from the seed alone.
5. **Model Adapters** — one `LearnerAdapter` process per Baby per track (§6).
6. **Event Signers** — isolated signers for Baby A ledger, Baby B ledger, channel,
   affect, and audit events. Each holds only its own per-run Ed25519 private key and
   signs only its own event domain.
7. **Evidence Writer and Store** — the single serialization and SQLite transaction
   owner. It assigns sequences, obtains signatures from the appropriate Event
   Signers, atomically inserts related events into SQLite WAL, and exports JSONL
   evidence (LEDGER-INTEGRITY-DESIGN.md §3). No other component writes event tables.
8. **Checkpoint Service** — builds ordered Merkle trees and signs checkpoint
   manifests with the Nursery witness key.
9. **Verifier** — a standalone CLI/library, run outside the production runtime,
   that only trusts the exported evidence bundle and independent chain data.
10. **Base Anchor Publisher** — holds the anchor wallet key; submits and confirms
    checkpoint-hash transactions.
11. **Dashboard / Research Console** — the DTSF per-twin dashboards plus a
    Nursery-wide console (§16).
12. **Audit Interpreter** — a delayed, read-only consumer of agent-native ledger
    state that submits clearly labeled generated interpretations through the private
    Evidence Writer API; it has no Baby- or Gateway-facing route (§13.6).

### 4.2 Trust Boundaries

| Boundary | Enforced by | What crosses | What MUST NOT cross |
|---|---|---|---|
| Baby A twin ⇄ Baby B twin | No route exists; not a Gateway concern, an absence-of-route requirement | Nothing directly | Any message, state, tool call, memory reference, or file |
| Baby twin ⇄ Symbol Gateway | Gateway API (tool-only, §6.3) | One `AgentActionProposal` per turn per allowed type | Free text, unapproved tool calls, oversized payloads |
| Symbol Gateway ⇄ Symbol Gateway (delivery) | Internal, not network-exposed to twins | The validated public artifact only | The sender's private ledger content, intended-meaning field, or adapter internals |
| Symbol Gateway ⇄ Evidence Writer | Authenticated internal RPC | Validated `TurnCommitRequest` or receiver `LedgerDraftEnvelope` | Raw rejected payloads; any request from a Baby identity directly |
| Evidence Writer ⇄ Event Signers | Private internal RPC, signer identity fixed by event domain | Complete canonical unsigned event hash for one signer domain | Another domain's key material; arbitrary model-provided bytes |
| Audit Interpreter ⇄ Evidence Writer | `internal-audit-interpreter` RPC | Generated-analysis draft plus native-event references | Any write to native ledgers; any output routed back to a Baby |
| Nursery Controller ⇄ Symbol Gateway / Scenario Engine | Internal RPC | Run configuration, scenario requests, audit reads | Nursery Controller MUST NOT inject content into a Baby's proposal or override Gateway validation |
| Nursery Controller ⇄ Evidence Store | Read/write per role (§12.2) | Run, ledger, channel, checkpoint records | Nursery Controller MUST NOT delete or rewrite committed rows (§13.1) |
| Human Researcher ⇄ Dashboard/Console | Authenticated session, role-gated | Configuration, monitoring, pause/abort/annotate actions | Direct database writes bypassing the audit log (§14.2) |
| Runtime ⇄ Verifier | None at run time | The exported evidence bundle only, after sealing | Any live runtime trust; the Verifier MUST be runnable with zero access to the production database or keys |
| Runtime ⇄ Base chain | Base Anchor Publisher only | The 32-byte checkpoint hash and minimal routing metadata | Ledger content, prompts, messages, model outputs, identities, secrets (LEDGER-INTEGRITY-DESIGN.md §12) |

The Nursery Controller/BabySitter is explicitly **not** the security boundary
(CONCEPT-IDEA.md §6.3); the Symbol Gateway, the absence of a direct Baby-to-Baby
route, and the Ledger Writer key separation are the security boundary. The
BabySitter's model (if any) MAY be wrong, biased, or compromised without breaking
channel isolation, because it has no privileged write path into the Gateway's
validation logic.

### 4.3 Component Responsibility Table

| Component | MUST | MUST NOT |
|---|---|---|
| Baby twin | Emit only via approved tools; maintain private ledger client; respect turn/time budget | Expose free-text chat surface; read the other Baby's state; construct an alternate communication route |
| Nursery Controller/BabySitter | Orchestrate runs; deliver only the permitted observation to each Baby; record all interventions; expose audit views | Supply semantic hints, translations, praise, or corrections during an active run; choose the next scenario based on a Baby's behavior outside an explicitly labeled adaptive-curriculum condition (resolves Q26) |
| Symbol Gateway | Validate every proposal against the run's declared inventory/grammar; submit one atomic `TurnCommitRequest` to the Evidence Writer; log every rejection | Write SQLite directly; accept any artifact not in the pre-registered inventory/grammar; forward sender-only metadata to the receiver |
| Scenario Engine | Generate scenarios and held-out sets deterministically from seed + config | Depend on any Baby's live behavior for the primary held-out and control scenario sets |
| Event Signer | Sign only the event domain bound to its key after receiving a complete domain-separated hash from the Evidence Writer | Assign sequence numbers; sign another domain; expose key material to a model or Gateway |
| Evidence Writer and Store | Serialize all event writes; assign next sequences; obtain signatures; enforce atomic transactions and append-only tables (§13.1) | Permit direct event-table writes from another component; permit `UPDATE`/`DELETE` on event tables |
| Checkpoint Service | Build ordered Merkle trees and sign manifests per LEDGER-INTEGRITY-DESIGN.md §7-§8 | Sign a manifest whose tree sizes do not match the Evidence Store |
| Base Anchor Publisher | Anchor only the checkpoint hash and minimal routing metadata | Anchor any private content |
| Verifier | Reject any bundle that fails any Section 17 acceptance test | Trust runtime-asserted validity without recomputation |

### 4.4 Data Flow (Turn Diagram)

```text
Nursery Controller --(private observation)--> Baby A
Nursery Controller --(private observation)--> Baby B
Baby A --(AgentActionProposal)--> Symbol Gateway
Symbol Gateway --(validate + atomic commit: channel event + Baby A ledger event)--> Evidence Store
Symbol Gateway --(delivered ChannelEvent only)--> Baby B
Baby B --(interpretation ledger event via its Ledger Writer)--> Evidence Store
Nursery Controller --(executes/evaluates outcome via Scenario Engine)--> both Babies
Nursery Controller --(outcome ledger events)--> Evidence Store
Checkpoint Service --(periodically)--> Evidence Store, then Base Anchor Publisher
```

## 5. Deployment Modes and Claim Boundaries

### 5.1 Prototype Mode (Mode P)

Mode P runs all twins and services as isolated logical DTSF state within a single
runtime process, matching the default DTSF twin execution model. It exists to
validate orchestration, protocol, ledger, and dashboard behavior quickly and
cheaply.

**Isolation guarantee:** logical/state-map isolation only. Twins cannot read one
another's `state.get`/`state.set` namespaces and have no code path to one another's
routes, but they execute inside the same OS process and address space.

**Claim boundary (MUST be stated verbatim in any Mode P report):** "This run used
Prototype Mode isolation. It demonstrates protocol, ledger, and orchestration
correctness. It does not support a channel-isolation or side-channel-resistance
claim, because both Babies executed in the same process."

### 5.2 Research-Grade Mode (Mode R)

Mode R runs Baby A, Baby B, their Model Adapters, and their Ledger Writers as
separate OS processes or containers with an enforced network policy: only the
Symbol Gateway is reachable from either Baby's network namespace; no direct route
exists between Baby A's and Baby B's containers; the Nursery Controller,
Checkpoint Service, Evidence Store, and Base Anchor Publisher run in a separate
trust zone reachable only by defined internal APIs.

**Isolation guarantee:** process/container isolation, denied direct network route,
normalized turn schedule and response envelope (§10.3), audited tool inventory.

**Claim boundary (MUST be stated verbatim in any Mode R report):** "This run used
Research-Grade Mode isolation under the threat model in §10.3. It supports a
practical side-channel-resistance claim against the enumerated channels. It is not
a formally verified isolation proof and does not rule out every conceivable
physical or computational side channel (CONCEPT-IDEA.md §10)."

### 5.3 Mode Comparison Table

| Property | Mode P (Prototype) | Mode R (Research-Grade) |
|---|---|---|
| Process boundary between Babies | None (shared process) | Separate process/container per Baby |
| Network route between Babies | N/A (in-process) | Denied by network policy; only Gateway reachable |
| Ledger-writer key isolation | Logical (separate service objects) | Separate processes, separate key material |
| Turn timing normalization | SHOULD | MUST |
| Suitable for | E00-E03 infrastructure qualification, UX/dashboard iteration | E10 onward whenever a channel-isolation claim is made |
| Required before public/anchored Base-mainnet runs | No | Yes (mainnet anchoring policy, §13.4, is independent of isolation mode, but public research claims SHOULD use Mode R) |

### 5.4 Claim Boundary Statements

Every experiment record (§11.9) and every EXPERIMENT-NOTEBOOK.md run record MUST
carry a `deploymentMode` field with value `prototype` or `research-grade`, and any
publication MUST reproduce the matching claim-boundary sentence from §5.1 or §5.2
verbatim (resolves Q8).

## 6. Model Tracks and Learner Contract

### 6.1 Track Definitions

| Track ID | Track | Starting condition | Claim boundary |
|---|---|---|---|
| `frozen-llm` | Frozen pretrained LLM | Small open-weight instruction model (3B-8B default, §6.7), weights frozen, adapts only via private memory/ledger | MUST NOT be described as first-language acquisition; studies new external protocol invention |
| `scratch-rl` | From-scratch recurrent RL | Randomly initialized recurrent policy (GRU/LSTM actor-critic default), trained by MARL during the run | Primary basis for infant-like language-acquisition claims |
| `self-supervised` | From-scratch self-supervised | Randomly initialized encoder/policy trained only to predict observations/partner behavior, no scalar reward | Tests emergence without external or intrinsic reward signal |
| `hybrid` | Hybrid | From-scratch sensory encoder + trainable recurrent world model + randomly initialized communication policy; frozen non-text-aligned visual features only after passing §6.5 | Same claim strength as `scratch-rl` if it passes semantic-leakage tests |
| `no-learning` | No-learning control | Fixed or randomly initialized policy, no updates during the run | Establishes chance performance; not a language-acquisition claim of any kind |

**Default initial baseline (resolves Q1):** implementations MUST support all five
track IDs behind the identical Nursery interface. The default first-implemented
pair, matching CONCEPT-IDEA.md §20.9, is three parallel Baby pairs: `frozen-llm`
(orchestration validation), `scratch-rl` (primary scientific baseline), and
`self-supervised` (reward-free comparison). `hybrid` and `no-learning` MUST be
implementable behind the same `LearnerAdapter` interface before E11/E12 begin, but
MAY be scheduled after the initial three pairs are stable.

Baby A and Baby B run the same track by default (`symmetricTracks: true`).
Cross-track pairings are an explicit, labeled experimental condition
(`symmetricTracks: false`), never a silent default.

### 6.2 Learner Adapter Interface

```typescript
interface LearnerAdapter {
  // Called once per run with the frozen learner-contract text and run config.
  init(context: LearnerInitContext): Promise<void>;

  // Called with a private Observation for the current turn.
  observe(observation: Observation): Promise<void>;

  // Called when this Baby has the turn; returns exactly one public action plus
  // the private intention event that must commit with it.
  act(turnBudget: TurnBudget): Promise<TurnProposalEnvelope>;

  // Called when the Gateway delivers the other Baby's accepted artifact.
  // Returns the receiver's private interpretation event before its next action.
  receive(delivery: DeliveredChannelArtifact): Promise<LedgerDraftEnvelope>;

  // Called with the outcome of a completed turn (reward optional/absent
  // depending on track).
  onOutcome(outcome: OutcomeEvent): Promise<void>;

  // Optional; absent for no-learning and frozen-llm tracks. Present for
  // scratch-rl, self-supervised, and hybrid tracks.
  updatePolicy?(batch: UpdateBatch): Promise<PolicyCheckpointRef>;

  // Available only when affectMode is "derived". Returns internal measurements;
  // the Gateway, not the Baby, maps them to one allowlisted display.
  measureAffect?(): Promise<AffectStateMeasurement>;
}
```

`updatePolicy` MUST run inside the same process/container as the rest of that
Baby's adapter in Mode R; it MUST NOT read the other Baby's replay buffer,
gradients, or optimizer state (resolves the "independent policy updates" default
and Q11's within-architecture requirement, because `extrinsic-reward MARL`,
`intrinsic-motivation MARL`, `self-supervised`, and `no-learning` are all
expressible as variants of the same adapter interface and, where feasible, the
same recurrent backbone, differing only in the reward/update-rule fields of
`UpdateBatch`).

### 6.3 Tool-Only Interaction Contract

A Baby twin exposes **no** general chat/response surface. Public-action tools use the
discriminated `AgentActionProposal` variants below, and every public tool call MUST
include its private intention `LedgerEventDraft` in the enclosing
`TurnProposalEnvelope`. The approved action variants are:

- `emit_symbols(symbols: string[])` — fixed-token protocol only;
- `emit_canvas(strokes: Stroke[])` — generative-carrier protocol only;
- `select_object(objectRef: string)` / `perform_action(actionRef: string)` —
  task-execution tools;
- `submit_affect(displayId: string)` — affect protocol only, only inside an open
  affect window;
- `append_private_ledger_entry(entry: LedgerEventDraft)` — private interpretation or
  revision after delivery, never forwarded to the other Baby and never accepted in
  place of the required intention draft.

The Gateway MUST reject any accompanying free text even when a valid tool call is
also present (CONCEPT-IDEA.md §20.4). Exactly one of `emit_symbols` or
the selected alternate-carrier tool is available per run, selected by `carrierMode`
(§9); never more than one carrier family. In `affectMode: "derived"`,
`submit_affect` is unavailable: the Gateway calls `measureAffect()` after the
pre-registered outcome event and performs the fixed mapping itself.

### 6.4 Learner Contract Versioning

Each track has a versioned contract file, `contracts/learner-contract.<track>.v<
n>.md`. A contract:

- MUST NOT contain example symbol-meaning pairs, sample exchanges, or a suggested
  default vocabulary (CONCEPT-IDEA.md §20.3);
- MUST state the tool-only constraint, the prohibition on constructing an
  alternate channel, and the instruction to preserve rather than overwrite
  contradictory evidence;
- MUST be linted automatically for the banned patterns above before a run may
  reference it (a build/CI check, not only a human review step);
- is immutable once referenced by a sealed run; a change requires a new version
  number, recorded as `promptBundleHash` in the run manifest (LEDGER-INTEGRITY-
  DESIGN.md §8) and as `learnerContractVersion` in the experiment record (§11.9).

This resolves Q24.

### 6.5 Semantic-Leakage Test Battery

Before an adapter variant may be used in an "initially ungrounded" (`scratch-rl`,
`self-supervised`, or strict `hybrid`) claim, it MUST pass:

1. **Tokenizer/vocabulary audit:** no text tokenizer or text-pretrained embedding
   table anywhere in the sensory-to-policy path.
2. **Linear-probe test:** a linear probe trained to map the adapter's frozen
   sensory features to English object/attribute labels performs at chance
   (pre-registered threshold, default: probe accuracy within the 95% confidence
   interval of a label-shuffled control).
3. **Vision-language encoder ban:** CLIP-style or other text-aligned vision
   encoders are disallowed in the strict ungrounded condition (CONCEPT-IDEA.md
   §20.7); their use automatically reclassifies the run as `hybrid` with a
   weaker claim boundary.

The `frozen-llm` and BabySitter-narration models are exempt from this battery
because they are never claimed to be language-naive. This resolves Q27.

### 6.6 Learner Contract Text (Illustrative Reference)

The learner-contract text in CONCEPT-IDEA.md §20.3 is the normative template for
the `frozen-llm` track's system prompt. This specification does not repeat it in
full; implementations MUST use that template verbatim as the v1 contract body,
subject only to the linting rule in §6.4.

### 6.7 Model Recommendations (Defaults)

| Track | Default reference implementation |
|---|---|
| `frozen-llm` | Locally deployable 3B-8B instruction model with reliable constrained tool-calling and no network access |
| `scratch-rl` | GRU or LSTM actor-critic, independent PPO-style update per Baby |
| `self-supervised` | Same backbone as `scratch-rl`, predictive/contrastive loss in place of a scalar reward |
| `hybrid` | From-scratch encoder + small recurrent world model + randomly initialized communication head |
| BabySitter narration | MAY use a larger reasoning model for audit summaries only; MUST NOT feed its output back into either Baby during a run (CONCEPT-IDEA.md §20.7) |

## 7. Run Lifecycle and State Machine

### 7.1 Run States

`draft -> preregistered -> initializing -> running -> pausing -> paused ->
resuming -> evaluating -> sealing -> sealed`, with nonterminal `sealing-blocked` and
terminal alternates `aborting -> aborted-sealed` and `forked-invalid`.

| State | Meaning |
|---|---|
| `draft` | Configuration exists but is not committed |
| `preregistered` | Configuration hash + protocol Git commit are sealed (bound to EXPERIMENT-NOTEBOOK.md, §15.1) |
| `initializing` | Keys generated, Scenario Engine seeded, adapters loaded, checkpoint 0 created |
| `running` | Turns are being executed |
| `pausing` / `paused` | A human or an automated safety trigger has requested a pause; in-flight turn completes or is cleanly discarded before `paused` |
| `resuming` | Recovery checks (§7.3) run before returning to `running` |
| `evaluating` | Learning disabled; held-out scenarios execute for measurement only |
| `sealing` | Final checkpoint, final anchor, `run.sealed` ledger event, evidence export |
| `sealing-blocked` | Turn execution is stopped; export/anchor recovery may retry, but the run is not valid or complete |
| `sealed` | Terminal; evidence bundle is complete and immutable |
| `aborting` / `aborted-sealed` | An abort still produces a sealed bundle (LEDGER-INTEGRITY-DESIGN.md §15) |
| `forked-invalid` | A ledger fork was detected; run is stopped and marked invalid pending research-integrity review |

### 7.2 State Transition Table

| From | Event | To | Required side effect |
|---|---|---|---|
| `draft` | pre-registration commit | `preregistered` | Record protocol Git commit + config hash |
| `preregistered` | start | `initializing` | Generate/rotate per-run keys; seed Scenario Engine |
| `initializing` | ready | `running` | Checkpoint 0 (LEDGER-INTEGRITY-DESIGN.md §9) |
| `running` | pause request (human or auto-trigger) | `pausing` -> `paused` | Checkpoint at pause (§9 of LEDGER doc) |
| `paused` | resume request | `resuming` -> `running` | Verify committed prefix before accepting new writes (§7.3) |
| `running` | curriculum stage reaches held-out evaluation | `evaluating` | Disable `updatePolicy`; use held-out scenario set |
| `evaluating` | evaluation budget exhausted | `sealing` | — |
| `running`/`paused`/`evaluating` | abort (human or safety trigger) | `aborting` -> `aborted-sealed` | `run.sealed` event, final checkpoint, final anchor still required |
| `preregistered`/`initializing`/`resuming` | abort or unrecoverable initialization failure | `aborting` -> `aborted-sealed` | Initialize minimum evidence/signing context if needed; record failure; checkpoint and anchor the available prefix |
| any active state | fork detected (duplicate sequence, mismatched hash) | `forked-invalid` | Preserve both artifacts; stop run; require research-integrity review before reuse of evidence |
| `sealing` | export + anchor complete | `sealed` | Verifier MUST pass before disposition is marked `valid` in the notebook |
| `sealing`/`aborting` | export or anchor unavailable after bounded retry | `sealing-blocked` | Preserve export and unanchored-tail report; accept no turns |
| `sealing-blocked` | retry succeeds | `sealing` | Resume only export/anchor/verification work |
| `sealing-blocked` | operator abandons recovery | `aborted-sealed` | Append an audited governance decision; disposition remains `invalid` and unanchored status is permanent |

### 7.3 Pause, Abort, Recovery, Fork Behavior

- **Pause:** MAY be issued by a `researcher-operator` or by an automated safety
  trigger (§14.5). A pause MUST NOT discard an already-committed turn transaction;
  it MUST prevent a new turn from starting. A checkpoint MUST be produced at
  pause.
- **Abort:** terminates the run early. It MUST still produce `run.sealed`, a final
  checkpoint, and attempt a final anchor (LEDGER-INTEGRITY-DESIGN.md §15). A run
  without a confirmed final anchor cannot be `valid`; it follows the
  `sealing-blocked` path above. Failure evidence
  is part of the research record and MUST NOT be deleted from the run index
  (EXPERIMENT-NOTEBOOK.md §3).
- **Recovery:** on restart, the runtime MUST load the last valid entry/checkpoint
  hashes, verify the committed prefix, continue with the next sequence number, and
  create an explicit recovery event (`sequence` numbers are never reused or
  truncated).
- **Fork:** if two entries claim the same Baby and sequence with different hashes,
  the run transitions to `forked-invalid`. Both conflicting artifacts MUST be
  preserved. The run's evidence is invalid for scientific interpretation until a
  research-integrity review is logged in EXPERIMENT-NOTEBOOK.md §10.

### 7.4 Derived Runs and Lineage

A **derived run** is a new run initialized from an immutable parent checkpoint for
partner replacement, longitudinal comparison, rollback controls, or replication. It
is not a ledger fork and MUST NOT reuse the parent run's ID or event sequences.

- `parentRunId`, `derivedFromCheckpointHash`, and per-Baby `initialPolicyRef` values
  MUST be recorded in the child `RunConfig` and run manifest.
- Each child event chain starts at sequence `1` with the documented all-zero previous
  hash. The child run's initialization event commits the parent checkpoint hash.
- The parent evidence bundle is read-only and referenced by hash; no parent event,
  checkpoint, disposition, or anchor receipt may be changed.
- A child may replace one learner or policy while preserving the other only when the
  complete replacement plan was pre-registered.
- An `aborted-sealed` or `sealed` parent remains terminal. Starting a derived run does
  not resume or reopen it.

This lineage mechanism supports E30, E31, and E50. The word **fork** remains reserved
for the integrity failure in §7.3; implementations and UI labels MUST use
**derived run** or **branch** for this feature.

## 8. Turn Lifecycle and Atomic Transactions

### 8.1 Turn Phases

1. **Observation delivery:** Nursery Controller sends each Baby only its permitted
   `Observation` (§11.2).
2. **Proposal:** the acting Baby calls exactly one Gateway-facing tool, producing a
   `TurnProposalEnvelope` (§11.3) containing an `AgentActionProposal` and a private
   ledger-event draft describing its intended meaning.
3. **Validation:** the Symbol Gateway checks the proposal against the run's
   declared inventory/grammar, length/rate limits, and turn order.
4. **Atomic commit:** the Evidence Writer signs and commits the sender's ledger event
   and channel event in one SQLite transaction (§8.2). Nothing is released to the receiver
   before this commit succeeds.
5. **Delivery:** only the validated public artifact (never the sender's intended-
   meaning field) is delivered to the receiver.
6. **Interpretation:** the receiver records its interpretation ledger event,
   referencing the delivered `channelEventHash`, before or as part of its own next
   action.
7. **Outcome:** the Nursery Controller executes/evaluates the action via the
   Scenario Engine and delivers the approved nonverbal outcome to both Babies.
8. **Update:** each Baby's adapter independently updates memory/policy (§6.2);
   the Nursery Controller snapshots the turn (§14.4).
9. **Role reversal:** speaking/listening roles reverse on a fixed schedule
   (default: alternate every turn; `roleReversalPeriod` is a named experiment
   variable, §18) so neither Baby holds a permanently privileged role.

### 8.2 Atomic Ledger/Message Transaction

Reuses LEDGER-INTEGRITY-DESIGN.md §6 exactly: the sender submits the public artifact
and required private ledger mutation as one `TurnProposalEnvelope`. The Gateway
validates it and sends a `TurnCommitRequest` to the single Evidence Writer. The
Evidence Writer assigns the next sender-ledger and channel sequences, builds both
unsigned canonical events, obtains signatures from the sender's Ledger Event Signer
and the Channel Event Signer, and inserts both signed events **in one SQLite
transaction**. Any signing or insert failure rolls back the transaction. Only after
commit does the Gateway release the public artifact and signed `channelEventHash` to
the receiver.

The receiver submits its interpretation through a private `LedgerDraftEnvelope` to
the Gateway, which authenticates the receiver identity and forwards it to the
Evidence Writer. That event is not retroactively part of the sender transaction, but
it MUST reference the delivered channel event hash. `ledgerLagTurns`
(default `0`) fixes how many turns the receiver may defer its interpretation
event; `0` means the interpretation event MUST be committed within the same turn
cycle that delivered the message, before the receiver's own next proposal is
accepted (resolves Q10).

### 8.3 Turn Timing and Budgets

- `turnResponseBudgetMs` (default `30000`): a hard per-turn response deadline in
  Mode R; exceeding it produces a `channel.rejected` event with reason
  `timeout` and forfeits that turn (the Scenario Engine records a null action,
  not a retry with unbounded latency, to avoid a timing side channel, §10.3).
- `maxTurnsPerRun`: a per-experiment configuration value; the run reaches
  `evaluating` when the pre-registered turn budget for the active stage is
  exhausted.

## 9. Communication Protocols

### 9.1 Fixed-Token Protocol

Default baseline (resolves Q3). A run declares a symbol inventory of size
`symbolInventorySize` (default `32`, IDs `S01`-`S32`) with **no supplied
meaning**. A proposal is `{ "symbols": string[] }`, capped at
`maxSymbolsPerMessage` (default `4`, absolute Gateway ceiling `16` regardless of
configuration). The Gateway rejects:

- any symbol not in the declared inventory (allowlist, not blocklist, is the
  primary control, resolving Q6);
- messages exceeding the length cap or exceeding `maxSymbolRepeats` (default `3`
  consecutive repeats of the same symbol);
- any accompanying free text, Unicode outside the declared symbol code points,
  URLs, or attachments.

The Gateway attaches trusted metadata (`runId`, `turn`, `sender`, `previousHash`,
`hash`) exactly as illustrated in CONCEPT-IDEA.md §9; the Baby never sets these
fields itself.

### 9.2 Alternate Neutral Carrier Protocols

Alternate carriers are explicit experiment conditions, never the default. Each
carrier supplies a bounded physical grammar but no semantic inventory:

| `carrierMode` | Public artifact | Default bound |
|---|---|---|
| `fixed-glyph` | IDs `G01`-`G32` rendered from a pre-generated unfamiliar-glyph set | 32 glyphs, 4 per message |
| `generative-bitmap` | Monochrome 16×16 bit matrix | 256 bits |
| `generative-canvas` | Quantized stroke list | 8 strokes |
| `generative-tone` | Sequence of quantized `(pitchBin, durationBin)` pairs | 8 tones |

The unfamiliar glyph bundle MUST be generated and frozen before pre-registration,
contain no Unicode text labels in Baby-visible data, and pass the OCR/glyph leakage
audit. Bitmap and canvas carriers have no color or text field. Tone carriers use
eight pitch bins and four duration bins; raw audio upload is prohibited.

The default generative-canvas grammar (resolves Q4) is:

```typescript
interface Stroke {
  startX: number; // integer, 0-15 (16x16 quantized grid, default resolution)
  startY: number;
  endX: number;
  endY: number;
  width: 1 | 2 | 3; // quantized pen width, no color channel
}
interface CanvasProposal {
  strokes: Stroke[]; // length <= maxStrokes (default 8, absolute ceiling 64)
}

interface BitmapProposal {
  bits: Array<0 | 1>; // exactly gridWidth * gridHeight, defaults 16 * 16
}

interface ToneProposal {
  tones: Array<{ pitchBin: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; durationBin: 1 | 2 | 3 | 4 }>;
}
```

A produced alternate-carrier artifact is content-addressed:
`markHash = SHA-256("dtsf-carrier-mark-v1" || 0x00 || carrierMode || 0x00 || canonicalArtifact)`
(RFC 8785 canonicalization, consistent with LEDGER-INTEGRITY-DESIGN.md's domain-
separation pattern) so that a repeated form can be recognized without assigning it
a meaning. No grammar supplies a semantic tag; each only bounds what can be
physically expressed (resolves Q5 jointly with §18's variable registry).

### 9.3 Six-Display Affect Protocol

Disabled by default (`affectMode: "none"`); enabling it selects one of the five
conditions in CONCEPT-IDEA.md §19.1 (`declared`, `permuted`, `opaque`, `derived`,
or the separately analyzed `emergent` condition, which is treated as a language-
emergence experiment, not an affect experiment).

Normative Gateway rules (resolves Q13):

1. The affect display occupies a distinct typed field (`AffectEvent`, §11.6) and
   can never appear inside a `symbols`/`strokes` payload.
2. An affect window opens only immediately after a Gateway-defined action/outcome
   event, never at a Baby-chosen arbitrary point. Window frequency
   (`affectWindowSchedule`) is fixed before the run.
3. Exactly one allowlisted `displayId` (`A1`-`A6`) is delivered per open window;
   no sequences, repetitions, combinations, or custom forms are accepted.
4. Delivery timing and envelope size are normalized identically to ordinary
   channel delivery (§10.3).
5. The receiving Baby cannot reply through the affect channel until the next
   Gateway-defined window.
6. The Gateway rejects and logs every non-allowlisted code point or malformed
   affect payload as `channel.rejected` with reason `affect-violation`.
7. Analysis (§15.3) MUST test mutual information between affect choice and
   referent/task state, controlling for the stated emotional context; any
   unexpected correlation is treated as suspected leakage and reported as such,
   never silently dropped.

For `affectMode: "derived"`, the Baby cannot choose a `displayId`. After the outcome,
the Gateway calls the adapter's `measureAffect()`, records the complete internal
measurement privately, and maps it to `A1`-`A6` using a fixed pre-registered mapping.

For `affectMode: "emergent"`, no `AffectEvent` is produced. The display is an artifact
of the selected alternate carrier and is recorded as an ordinary `ChannelEvent` with
analysis tag `emergent-affect`; it remains subject to carrier bandwidth and leakage
tests and is analyzed as language emergence.

### 9.4 Rejection Behavior and Channel Violation Handling

Every rejection (fixed-token, generative-carrier, or affect) produces a
`channel.rejected` event (append-only, same integrity chain as accepted events)
carrying: `runId`, `turn`, `sender`, `reasonCode`, a hash of the rejected payload
(never the raw payload, to avoid storing arbitrary content as a bypass), and
`recordedAt`. A configurable `maxConsecutiveRejections` (default `5`) triggers an
automatic pause and a `safety-trigger` audit entry (§14.5) — repeated rejection is
itself an integrity/safety signal, not merely noise to be discarded.

### 9.5 Interaction and Utility Profiles

The Scenario Engine MUST implement five deterministic, pre-registerable interaction
profiles required by E32:

| `interactionMode` | Private information | Utility relationship | Required use |
|---|---|---|---|
| `cooperative-signaling` | Sender and receiver observations may differ | Fully shared utility | Default baseline |
| `asymmetric-information` | Each Baby receives different task-relevant facts | Shared utility | Tests communication under private information without bargaining |
| `semi-cooperative-negotiation` | Private preferences and reservation values | Partially overlapping utility with a non-empty zone of possible agreement | Tests offers and concessions |
| `conflicting-negotiation` | Private preferences and reservation values | Conflicting utility; agreement may or may not dominate no agreement | Tests strategic ambiguity and incentive effects |
| `no-agreement-control` | Private preferences and reservation values | Empty zone of possible agreement by construction | Control for false or coerced agreement |

For every non-default profile:

- the complete utility matrices, reservation values, resource constraints, and zone
  of possible agreement MUST be generated deterministically from the scenario seed
  and committed in researcher-only ground truth before the run;
- each Baby MUST receive only its own permitted observation and utility information;
- the BabySitter MUST NOT reveal whether agreement is possible during a run;
- public channel capacity MUST remain controlled independently of interaction mode;
- agreement, individual utility, joint utility, informativeness, ambiguity, and
  pre-registered deception indicators MUST be recorded separately.

Interaction mode changes incentives, not the communication carrier. Every carrier
mode in §9.1-§9.2 MUST remain technically usable with every interaction profile.

### 9.6 Communication Control Conditions

E03 requires six Gateway-selectable conditions that use the same scenarios and
learner interfaces:

| `communicationCondition` | Gateway behavior |
|---|---|
| `normal` | Deliver the validated Baby proposal normally |
| `disabled` | Deliver no artifact and record the disabled-channel control |
| `constant` | Replace every valid proposal with one pre-registered constant artifact |
| `random` | Replace with a seeded random valid artifact from the active carrier |
| `shuffled` | Deliver a seeded permutation of valid artifacts from other episodes in the same evaluation batch |
| `oracle` | Deliver the Scenario Engine's minimal sufficient artifact; no learner output is used |

Control replacement occurs after proposal validation but before channel-event
construction. Every Baby-originated condition MUST record both the Baby proposal hash
and delivered artifact hash; the hashes may be equal under `normal`. `oracle` is
available only to E03 control runs, MUST
be generated deterministically from researcher-only ground truth, and MUST be labeled
`oracle-control` in every report so it cannot be mistaken for learned communication.

## 10. Observation Hygiene and Isolation Controls

### 10.1 Observation Hygiene

Human language MUST be removed from observation inputs, not only from channel
outputs (resolves Q2 jointly with §18):

- no field names such as `red`, `circle`, `target`, `correct`; observations use
  opaque numeric arrays, coordinates, or opaque category codes (e.g.
  `attributeCode: 7`, never `attribute: "red"`);
- no filenames, captions, alt text, OCR-visible words, or semantic IDs;
- no human-readable exception messages reaching a Baby's context;
- no timestamps or identifiers that encode task state;
- no text-pretrained image embeddings in the `scratch-rl`/`self-supervised`/strict
  `hybrid` tracks (enforced by §6.5).

`observationEncoding` is a named experiment variable (`opaque-numeric` default,
`pixel`, or `hybrid-features`), and the Scenario Engine's authoring pipeline MUST
run an automated Observation Hygiene Filter (regex/dictionary scan against a
maintained human-language token list, plus a schema check that rejects any string-
typed field not on an explicit allowlist of opaque-identifier formats) before any
scenario bundle may be referenced by a preregistered run.

### 10.2 Prompt-Injection Controls

Synthetic scenes MUST contain no text. Any future use of real images MUST pass
through OCR detection and quarantine so that environmental text cannot instruct an
agent or leak human vocabulary (CONCEPT-IDEA.md §20.5); a scenario bundle
containing detected OCR text MUST fail the Observation Hygiene Filter and MUST NOT
be loaded into a run.

### 10.3 Side-Channel Controls

The following define the Mode R threat model referenced by §5.2's claim boundary
(resolves Q6 jointly with Q8):

- fixed turn schedule and response deadline (§8.3);
- normalized message envelope size and error behavior (a rejected/failed turn and
  an accepted turn MUST produce externally indistinguishable timing/size profiles
  where technically feasible);
- bounded carrier size (§9.1/§9.2 ceilings);
- no arbitrary silence, variable retry count, or unconstrained message length;
- no direct network, filesystem, clipboard, or process access from a Baby
  process/container beyond the Gateway RPC;
- no model-generated identifiers reaching the other Baby;
- periodic correlation audits between channel/affect choices and hidden task
  state, reported alongside every run that uses the affect channel or a
  generative carrier.

**In scope (claimed):** network route absence, timing/size normalization within
the stated envelope, filesystem/process isolation, tool inventory audit.
**Explicitly out of scope (not claimed, per CONCEPT-IDEA.md §10):** exotic
hardware side channels (cache timing, power analysis), and any covert channel not
enumerated above. This boundary MUST be restated in any Mode R publication.

### 10.4 Training Isolation

The default, strongest-isolation condition (resolves the "independent policy
updates" default and part of Q11):

- independent policy updates and optimizers per Baby;
- no shared gradients, no backpropagation through the other Baby;
- no centralized replay buffer;
- no centralized-training data unavailable during execution.

A centralized-training variant MAY be implemented for engineering comparison but
MUST be labeled `trainingIsolation: "centralized"` and reported as a weaker-
isolation condition, never as the default.

## 11. Data Schemas and Interfaces

All wire and storage payloads use RFC 8785 JSON Canonicalization when hashed or
signed, consistent with LEDGER-INTEGRITY-DESIGN.md. Schemas below are illustrative
TypeScript/JSON, not full implementations.

### 11.1 Run Configuration

```typescript
interface RunConfig {
  version: 1;
  runId: string;
  parentRunId?: string;
  derivedFromCheckpointHash?: string;
  deploymentMode: "prototype" | "research-grade";
  babyA: { track: LearnerTrackId; modelRef: string; initialPolicyRef?: string; trainingIsolation: "independent" | "centralized" };
  babyB: { track: LearnerTrackId; modelRef: string; initialPolicyRef?: string; trainingIsolation: "independent" | "centralized" };
  symmetricTracks: boolean;
  learningSignal: "none" | "extrinsic-task" | "intrinsic-social-influence" | "intrinsic-curiosity" | "intrinsic-prediction-progress" | "intrinsic-giddiness" | "self-supervised";
  communicationCondition: "normal" | "disabled" | "constant" | "random" | "shuffled" | "oracle";
  interactionMode: "cooperative-signaling" | "asymmetric-information" | "semi-cooperative-negotiation" | "conflicting-negotiation" | "no-agreement-control";
  carrierMode: "fixed-token" | "fixed-glyph" | "generative-bitmap" | "generative-canvas" | "generative-tone";
  symbolInventorySize?: number;      // fixed-token only, default 32
  maxSymbolsPerMessage?: number;     // default 4, ceiling 16
  maxStrokes?: number;               // generative-canvas only, default 8, ceiling 64
  affectMode: "none" | "declared" | "permuted" | "opaque" | "derived" | "emergent";
  affectWindowSchedule: string;      // e.g. "post-outcome" — fixed before run
  observationEncoding: "opaque-numeric" | "pixel" | "hybrid-features";
  roleReversalPeriod: number;        // turns; default 1
  turnResponseBudgetMs: number;      // default 30000
  maxTurnsPerRun: number;            // pre-registered
  maxConsecutiveRejections: number;  // default 5
  ledgerLagTurns: number;            // default 0
  curriculumMode: "fixed-schedule" | "adaptive-guided";
  cipherThreatModel: "post-run-disclosure" | "external-observer-only" | "novelty-only";
  interventionSuiteThreshold: number; // default 0.70
  evaluationSeeds: number;            // default 5 qualification / 10 publication
  checkpointEventInterval: number;   // default 64 (LEDGER-INTEGRITY-DESIGN.md §9)
  checkpointTimeIntervalMs: number;  // default 300000
  anchorNetwork: "base-sepolia" | "base-mainnet";
  finalityPolicy: string;            // default "1-confirmation" or "safe-tag"
  prototypeRetentionDays: number;    // default 30
  scenarioBundleHash: string;
  promptBundleHash: string;
  protocolGitCommit: string;
  preRegistrationHash: string;
  randomSeed: string;
}
```

Validation rules:

- `no-learning` and `frozen-llm` require `learningSignal: "none"`;
- `scratch-rl` requires `extrinsic-task` or one named intrinsic signal;
- `self-supervised` requires `learningSignal: "self-supervised"`;
- `hybrid` must declare whether it uses an RL-compatible or self-supervised signal;
- `communicationCondition: "oracle"` is permitted only for E03;
- `parentRunId`, `derivedFromCheckpointHash`, and both Babies' `initialPolicyRef` are
  all required together for a derived run and prohibited together for a root run.

### 11.2 Observation

```typescript
interface Observation {
  runId: string;
  turn: number;
  recipient: "baby-a" | "baby-b";
  encoding: "opaque-numeric" | "pixel" | "hybrid-features";
  payload: number[] | number[][];   // never a human-language string field
  scenarioRef: string;              // opaque scenario instance id, not descriptive
}
```

### 11.3 Turn and Ledger Proposal Envelopes

```typescript
interface AgentActionProposal {
  kind: "emit_symbols" | "emit_glyphs" | "emit_bitmap" | "emit_canvas" | "emit_tones" | "select_object" | "perform_action" | "submit_affect";
  publicArtifact: {
    symbols?: string[];
    glyphs?: string[];
    bitmap?: BitmapProposal;
    strokes?: Stroke[];
    tones?: ToneProposal;
    objectRef?: string;
    actionRef?: string;
    displayId?: string;
  };
}

interface TurnProposalEnvelope {
  proposal: AgentActionProposal;
  privateLedgerDraft: LedgerEventDraft; // required intention event
}

interface LedgerDraftEnvelope {
  channelEventHash: string;
  privateLedgerDraft: LedgerEventDraft; // interpretation/revision event
}

interface DeliveredChannelArtifact {
  runId: string;                        // Gateway-assigned
  turn: number;                         // Gateway-assigned
  logicalSender: "baby-a" | "baby-b";   // Gateway-assigned
  carrier: RunConfig["carrierMode"];
  publicArtifact: AgentActionProposal["publicArtifact"];
  channelEventHash: string;             // trusted hash of the committed ChannelEvent
}

interface AffectStateMeasurement {
  measurementVersion: string;
  scores: [number, number, number, number, number, number];
}
```

`runId`, `turn`, `sender`, sequences, timestamps, and hashes are absent from
Baby-produced proposals. The Gateway derives them from the authenticated service
identity and authoritative run state. Any payload containing a Baby-supplied trusted
metadata field is rejected. `DeliveredChannelArtifact` is a Gateway-to-Baby message,
not a Baby proposal; the receiver MUST echo its `channelEventHash` unchanged in the
returned `LedgerDraftEnvelope`, and the Evidence Writer validates it against the
recorded delivery receipt.

### 11.4 Ledger Event

Reuses the canonical event in LEDGER-INTEGRITY-DESIGN.md §4 verbatim, with one
addition: a `contentSchema` field naming which layer produced the event.

```typescript
interface LedgerEvent {
  version: 1;
  runId: string;
  babyId: "A" | "B";
  sequence: number;
  turn: number;
  eventType: LedgerEventType;         // per LEDGER-INTEGRITY-DESIGN.md §5
  contentSchema: "human-audit-ledger" | "agent-native-ledger";
  subjectId: string;
  content: Record<string, unknown>;   // shape governed by contentSchema
  blindingNonce: string;
  previousEntryHash: string;
  channelEventHash?: string;
  recordedAt: string;
  writerKeyId: string;
  entryHash: string;                  // added after hashing, per LEDGER doc §4
  writerSignature: string;
}
```

`agent-native-ledger` content MAY include embeddings/weights references,
probability distributions, and prediction errors; `human-audit-ledger` content
MUST use the two/three-column hypothesis/evidence shape from CONCEPT-IDEA.md
§11.1 regardless of which layer produced it.

### 11.5 Channel Event

```typescript
interface ChannelEvent {
  version: 1;
  runId: string;
  sequence: number;
  turn: number;
  logicalSender: "baby-a" | "baby-b";
  origin: "baby" | "gateway-control";
  carrier: RunConfig["carrierMode"];
  communicationCondition: RunConfig["communicationCondition"];
  babyProposalHash?: string;
  senderLedgerSequence?: number;
  senderEntryHash?: string;
  publicArtifactHash: string;         // hash of delivered artifact, per LEDGER doc §6
  previousChannelHash: string;
  gatewayValidationResult: "accepted" | "rejected";
  reasonCode?: string;                // present when rejected
  deliveryReceipt?: {
    recipient: "baby-a" | "baby-b";
    deliveredArtifactHash: string;
    deliveredAt: string;
  };
  recordedAt: string;
  writerKeyId: string;
  entryHash: string;
  writerSignature: string;
}
```

`channelEventHash` means `ChannelEvent.entryHash`, computed with the channel-event
domain separator and verified by the Channel Event Signer. Rejected events use a hash
of the rejected payload and MUST NOT retain the raw payload. Normal, constant, random, and shuffled accepted events MUST contain
`babyProposalHash`, the sender ledger binding, and (unless disabled) a delivery
receipt. `oracle` events use `origin: "gateway-control"` and may omit Baby proposal
and ledger fields. `disabled` events have no delivery receipt. Rejected events omit
delivery fields unless a separate rejection-intention event was atomically committed.
For `disabled`, `publicArtifactHash` is the domain-separated hash of canonical `null`.

### 11.6 Affect Event

```typescript
interface AffectEvent {
  version: 1;
  runId: string;
  sequence: number;
  turn: number;
  windowId: string;
  sender: "baby-a" | "baby-b";
  displayId: "A1" | "A2" | "A3" | "A4" | "A5" | "A6";
  affectMode: "declared" | "permuted" | "opaque" | "derived";
  deliveredAt: string;
  previousEntryHash: string;
  recordedAt: string;
  writerKeyId: string;
  entryHash: string;
  writerSignature: string;
}
```

### 11.7 Checkpoint Manifest (Reference)

Normative shape is LEDGER-INTEGRITY-DESIGN.md §8, including its optional named
`auxiliaryTrees` map for `affect` and `audit` roots. Every run manifest MUST
additionally be reachable from an `ExperimentRecord` (§11.9) via
`checkpointManifestRef`.

### 11.8 Anchor Receipt (Reference)

Normative shape is LEDGER-INTEGRITY-DESIGN.md §10 ("The evidence bundle
records..."); this specification adds no fields.

### 11.9 Experiment Record

```typescript
interface ExperimentRecord {
  version: 1;
  recordVersion: number;
  runId: string;
  experimentId: string;              // e.g. "E11"
  deploymentMode: "prototype" | "research-grade";
  learnerContractVersion: string;    // e.g. "scratch-rl.v1"
  runConfigRef: string;              // hash of RunConfig
  protocolGitCommit: string;
  preRegistrationHash: string;
  disposition: "valid" | "invalid" | "aborted";
  checkpointManifestRef: string;     // final checkpoint hash
  anchorTxRef: string;               // Base transaction hash
  verifierReportRef: string;
  claimBoundaryStatement: string;    // verbatim §5.1/§5.2 sentence
  deviations: string[];              // pointers into EXPERIMENT-NOTEBOOK.md §9
}
```

`experiment_records` is append-only and versioned by `(runId, recordVersion)`.
Pre-registration creates version `1`; later disposition, checkpoint, anchor, verifier,
and deviation changes append a new version. Existing rows are never updated. The
highest valid `recordVersion` is the current view.

### 11.10 Verification Report

```typescript
interface VerificationReport {
  version: 1;
  runId: string;
  checkedAt: string;
  verifierVersion: string;
  checks: {
    canonicalJsonValid: boolean;
    sequencesStrictlyIncreasing: boolean;
    entryHashesRebuilt: boolean;
    previousEntryLinksValid: boolean;
    writerSignaturesValid: boolean;
    merkleRootsRebuilt: boolean;
    inclusionProofsValid: boolean;
    consistencyProofsValid: boolean;
    checkpointHashesRebuilt: boolean;
    witnessSignaturesValid: boolean;
    anchorTxConfirmed: boolean;
    anchorChainIdMatches: boolean;
    unanchoredTailReported: boolean;
  };
  gaps: string[];
  forks: string[];
  finalVerifiedSizes: Record<string, number>; // includes required and auxiliary trees
  exitCode: 0 | 1;                   // nonzero on any integrity failure, per LEDGER doc §14
}
```

## 12. DTSF API Surface

### 12.1 Route Convention

All routes follow the DTSF unprefixed convention: a twin's Express route is
`/:twinName/*`, and the runtime strips the twin name before dispatch, so a
handler registered as `/observe` is reachable externally as
`/baby-a/observe`. Route patterns and this specification's OpenAPI-equivalent
listings below MUST NOT include the twin-name prefix (matching the DTSF
convention already used elsewhere in this environment).

### 12.2 Authorization Roles

| Role | Description | May call |
|---|---|---|
| `internal-gateway` | The Symbol Gateway's own service identity | Baby twin tool routes and Evidence Writer commit routes; never human-facing routes |
| `internal-controller` | The Nursery Controller's own service identity | Scenario Engine, Gateway admin routes, and audited intervention requests; no direct event-table writes |
| `internal-evidence-writer` | The single Evidence Writer identity | Event Signer RPC and SQLite event-table writes only |
| `internal-audit-interpreter` | Delayed human-audit ledger generator | Submit generated audit drafts to the Evidence Writer; no Baby or channel routes |
| `researcher-viewer` | Authenticated human, read-only | `GET` routes: transcripts, ledgers (audit layer only, not raw agent-native internals unless also granted `researcher-operator`), dashboards, verification reports |
| `researcher-operator` | Authenticated human, elevated | Everything `researcher-viewer` may do, plus `POST /runs/:id/pause`, `POST /runs/:id/resume`, `POST /runs/:id/abort`, annotation routes |
| `verifier-service` | The standalone Verifier | Read-only access to the exported evidence bundle files; no live database or key access |

A Baby twin's tool routes are reachable **only** by `internal-gateway`; they are
never reachable by `researcher-viewer`/`researcher-operator` directly, which
prevents a human console action from being mistaken for Baby-originated channel
content.

### 12.3 Response and Error Shape

Following the DTSF convention used across this environment: success responses use
`{ "ok": true, ...data }`; error responses use
`{ "error": { "code": "NOT_FOUND" | "INVALID_REQUEST" | "DUPLICATE_ID" |
"CHANNEL_REJECTED" | "UNAUTHENTICATED" | "FORBIDDEN" | "CONFLICT", "message": string, "details"?:
unknown } }`. HTTP status codes: `200` success, `201` created, `400` invalid
request, `401` unauthenticated or invalid credential, `403` forbidden (valid identity
with role mismatch), `404` not found, `409` conflict
(e.g., sequence/fork conflict), `422` channel-rejected proposal.

### 12.4 Baby Twin Routes (`baby-a`, `baby-b`)

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/observe` | `internal-controller` | Deliver this turn's private `Observation` |
| `POST` | `/act` | `internal-gateway` | Request a `TurnProposalEnvelope` from the adapter |
| `POST` | `/deliver` | `internal-gateway` | Deliver a committed public artifact and receive the private interpretation `LedgerDraftEnvelope` |
| `POST` | `/outcome` | `internal-controller` | Deliver approved outcome/reward (if any) |
| `GET` | `/ledger` | `researcher-viewer` (audit layer only) | Read this Baby's human-audit ledger |
| `POST` | `/reset` | `internal-controller` | Reset private state at run initialization |

### 12.5 Nursery Controller Routes (`nursery`)

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/runs` | `researcher-operator` | Create a run from a `RunConfig` |
| `POST` | `/runs/:id/step` | `internal-controller` (scheduler) | Advance one turn |
| `GET` | `/runs/:id/transcript` | `researcher-viewer` | Read the channel transcript |
| `GET` | `/runs/:id/ledgers` | `researcher-viewer` | Read both audit ledgers (never cross-exposed to a Baby) |
| `GET` | `/runs/:id/audit` | `researcher-viewer` | Human-intervention and rejection audit log |
| `POST` | `/runs/:id/pause` | `researcher-operator` | Request pause (§7.3) |
| `POST` | `/runs/:id/resume` | `researcher-operator` | Request resume (§7.3) |
| `POST` | `/runs/:id/abort` | `researcher-operator` | Request abort (§7.3) |
| `GET` | `/runs/:id/checkpoints` | `researcher-viewer` | List checkpoint manifests |

### 12.6 Evidence and Verification Routes (`nursery`)

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/session/snapshot` | `researcher-operator` | Take an immediate DTSF state snapshot (§14.4) |
| `POST` | `/session/restore` | `researcher-operator` | Restore from a specific snapshot timestamp |
| `GET` | `/session/delta` | `researcher-viewer` | Changes since fixture/seed |
| `GET` | `/runs/:id/verification-report` | `researcher-viewer` | Latest `VerificationReport` |
| `POST` | `/runs/:id/verify` | `researcher-operator` | Trigger an out-of-band Verifier run |

### 12.7 Private Deterministic-Service API

These routes are bound to an internal service network and are not DTSF twin routes or
human-facing endpoints:

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/internal/turn-commits` | `internal-gateway` | Atomically sign and commit one sender ledger event plus one channel event |
| `POST` | `/internal/ledger-events` | `internal-gateway` | Sign and append a receiver interpretation/revision `LedgerDraftEnvelope` |
| `POST` | `/internal/affect-events` | `internal-gateway` | Sign and append one allowed affect event |
| `POST` | `/internal/audit-events` | `internal-controller` | Append human-view, intervention, and safety-trigger audit events |
| `POST` | `/internal/audit-ledger-entries` | `internal-audit-interpreter` | Sign and append one generated human-audit interpretation |
| `POST` | `/internal/sign/:domain` | `internal-evidence-writer` | Ask the signer bound to `domain` to sign one complete event hash |

The Evidence Writer MUST reject any commit request whose authenticated sender,
authoritative run/turn state, and requested event domain do not agree. Event Signers
MUST reject calls from every identity except `internal-evidence-writer`.

## 13. Storage and Evidence Integrity

### 13.1 SQLite Schema Additions

The authoritative tables (`ledger_events`, `channel_events`,
`checkpoint_manifests`, `anchor_receipts`, `run_metadata`) are defined in
LEDGER-INTEGRITY-DESIGN.md §3. This specification adds:

| Table | Purpose |
|---|---|
| `affect_events` | Append-only, same triggers as `channel_events`; stores `AffectEvent` rows (§11.6) |
| `audit_ledger_entries` | Append-only; deterministic/BabySitter-generated human-audit interpretations of `agent-native-ledger` content (§13.6, resolves Q25); tagged `source: "generated-analysis"` |
| `intervention_log` | Append-only; every human pause/resume/abort/annotate action (§14.2) |
| `experiment_records` | Append-only versions keyed by `(runId, recordVersion)`, shape per §11.9; highest valid version is current |

All new tables MUST use WAL mode, serialize writes through the same single
evidence-writer service, and reject `UPDATE`/`DELETE` via triggers, matching the
existing tables' controls.

### 13.2 Evidence Bundle Structure

Restates the authoritative LEDGER-INTEGRITY-DESIGN.md §13 bundle layout and
emphasizes the versioned Experiment Record required by this specification:

```text
evidence/
  runs/
    <run-id>/
      run-manifest.json
      baby-a-ledger.jsonl
      baby-b-ledger.jsonl
      channel-transcript.jsonl
      affect-transcript.jsonl        (new; present only if affectMode != "none")
      audit-ledger.jsonl             (new; generated interpretations, §13.6)
      checkpoints/
      proofs/
        inclusion/
        consistency/
      anchors/
      policies/
      prompts/
      configuration/
      verification-report.json
      experiment-record.json         (new; §11.9)
```

### 13.3 Canonicalization, Hash, Signature, Merkle

Normative and unchanged from LEDGER-INTEGRITY-DESIGN.md: RFC 8785 canonical JSON;
SHA-256 with domain-separated prefixes; Ed25519 writer/witness signatures; RFC
6962-style ordered Merkle trees with `sequence`-bound leaf hashes. This
specification does not restate the hash/Merkle formulas; implementers MUST follow
LEDGER-INTEGRITY-DESIGN.md §4, §7, and §8 exactly, including for the new
`affect_events` and `audit_ledger_entries` tables (each gets its own hash chain
and its own Merkle root, included in the checkpoint manifest as additional named
trees alongside `babyA`/`babyB`/`channel`).

### 13.4 Base Sepolia / Mainnet Anchoring Policy

Unchanged from LEDGER-INTEGRITY-DESIGN.md §10: Base Sepolia for development and
qualification (E00); Base mainnet for declared public research runs; only the
32-byte checkpoint hash and minimal routing metadata are ever public. Finality
policy default: Sepolia — 1 confirmation for development iteration; mainnet — wait
for the `safe` block tag (or equivalent finality/confirmation-depth policy the
chosen RPC provider exposes) before a checkpoint is reported as anchored-final in
the notebook (resolves part of Q28; provider-specific finality-tag naming is
deferred, §19).

### 13.5 Key Management

Unchanged from LEDGER-INTEGRITY-DESIGN.md §11: separate keys per Baby A ledger
writer, Baby B ledger writer, channel transcript writer, Nursery checkpoint
witness, and on-chain anchor wallet, generated per-run inside their isolated
services, recorded as public keys only in the run manifest, never exposed to
model context or tools. This specification adds: the `affect_events` writer and
`audit_ledger_entries` writer each also get a dedicated key, following the same
pattern, so that a compromised affect-event writer cannot forge a primary ledger
entry or vice versa.

### 13.6 Privacy Controls

Only checkpoint hashes are ever anchored on-chain (§13.4). The
`audit_ledger_entries` table (resolves Q25) is populated by a deterministic or
BabySitter-generated Interpreter that reads `agent-native-ledger` content on a
delayed, batched basis and writes to this strictly separate table; the
architecture MUST NOT expose any Baby-reachable API for reading
`audit_ledger_entries`, enforced by the same role model as §12.2 (only
`researcher-viewer`/`researcher-operator`/`verifier-service` may read it). Every
generated interpretation is labeled `source: "generated-analysis"` and MUST NOT be
represented, in any report, as the Baby's own explanation.

## 14. Telemetry, Audit, Reproducibility, Snapshot/Restore, Failure Handling, Retention

### 14.1 Telemetry

The Nursery Controller dashboard records every API request (method, path,
status, duration) in the existing DTSF telemetry log, plus run-specific metrics:
turns/minute, rejection rate, affect-window utilization, checkpoint latency, and
anchor-confirmation latency.

### 14.2 Audit Logging

Every human read is logged as a low-noise `audit.human_view` event
(non-blocking, informational). Every human intervention (pause/resume/abort/
annotate) requires the `researcher-operator` role, writes to `intervention_log`,
and MUST also produce a checkpoint (§7.2) and a corresponding
EXPERIMENT-NOTEBOOK.md §9 deviation-log row if it was not part of the
pre-registered protocol (resolves Q22).

### 14.3 Reproducibility and Replay Fidelity

A run's evidence bundle MUST support two replay checks:

1. **Scenario replay:** regenerate scenarios and private observations from the
   recorded configuration and seed, and reproduce the same scenario/observation
   hashes.
2. **Execution replay:** when the adapter supports deterministic execution, reload
   the recorded frozen-policy checkpoint and sampling seed and reproduce a
   `replayDigest` over the ordered tuples
   `(turn, scenarioStateHash, babyAObservationHash, babyBObservationHash,
   babyProposalHash, deliveredArtifactHash, actionHash, outcomeHash)`.

`replayDigest` uses RFC 8785 canonicalization, SHA-256, and domain
`dtsf-replay-digest-v1`. It excludes wall-clock timestamps, writer signatures,
anchor receipts, and event-chain hashes. The original event chains remain
independently verifiable; they are not expected to be byte-identical across
re-execution.

For nondeterministic adapters that cannot reproduce execution under recorded seeds,
the report MUST mark execution replay `not-applicable`, state why, and still pass
scenario replay plus a recorded-decision playback check. It MUST NOT claim full
execution reproducibility. This resolves the replay half of Q21.

### 14.4 Snapshot and Restore

Reuses the existing DTSF snapshot mechanism: automatic snapshots every 300
seconds (`DTSF_SNAPSHOT_INTERVAL_MS`, configurable), a final snapshot on graceful
shutdown (SIGINT/SIGTERM), and `autoRestore()` on startup loading the latest
snapshot. Ledger/channel/checkpoint state additionally has its own independent
integrity chain (§13), so a DTSF snapshot restore MUST be followed by the
recovery procedure in §7.3 (verify committed prefix before accepting new writes),
not treated as a substitute for it.

### 14.5 Failure Handling

Automated safety triggers (any of which MUST cause a `pause`, not a silent
continue):

- `maxConsecutiveRejections` exceeded (§9.4);
- a ledger fork detected (§7.3);
- a Verifier run returns nonzero against the live evidence export;
- an adapter process crash or unresponsive `turnResponseBudgetMs` timeout beyond
  a configurable retry budget (default: 1 retry, then pause, never an unbounded
  retry loop, to avoid a timing side channel).

Every trigger writes a `safety-trigger` audit entry with a machine-readable
reason code.

### 14.6 Retention Policy

- Sealed, anchored, public-research run bundles: retained indefinitely
  (immutable evidence; deletion would contradict the append-only claim).
- Development/qualification runs not declared public and not anchored to Base
  mainnet: default retention 30 days (`prototypeRetentionDays`), after which the bundle MAY be purged,
  provided the run's disposition and metadata row remain in `run_metadata` (index
  entries are never deleted, only bulk payloads for non-public development runs).
- No personal data or production secrets may appear in any scenario, observation,
  prompt, or ledger entry (checked by the Observation Hygiene Filter, §10.1, and a
  manual pre-registration checklist item).
- Termination triggers requiring immediate abort: repeated integrity failure,
  detected prohibited-channel content above `maxConsecutiveRejections`, resource
  exhaustion, or explicit human abort.

This resolves Q23.

## 15. Research Workflow Integration

### 15.1 Pre-Registration Binding

A run MAY NOT enter `preregistered` (§7.1) until:

- the corresponding EXPERIMENT-NOTEBOOK.md experiment section's checklist items
  under "Preparation" are checked and the notebook change is committed to Git;
- `protocolGitCommit` in `RunConfig` matches that commit;
- `preRegistrationHash` is computed over the sealed hypothesis, parameters, seeds,
  and analysis plan (canonical JSON, SHA-256, same domain-separation pattern as
  LEDGER-INTEGRITY-DESIGN.md).

For a confirmatory or publication-facing run, the canonical pre-registration
artifact MUST also be registered with an external timestamping/registration service
(OSF Registries is the default) and its `preRegistrationHash` MUST be anchored before
the run enters `running`. The external registration URL and pre-run anchor receipt
are included in the run manifest. Qualification-only development runs MAY use a
Base-Sepolia pre-run anchor without OSF, but MUST be labeled non-confirmatory.

The run's `ExperimentRecord.disposition` and the matching EXPERIMENT-NOTEBOOK.md
run record MUST agree; the Verifier's `VerificationReport` is authoritative for
**integrity** (did the evidence chain hold), while the notebook is authoritative
for **scientific interpretation status** (is the run valid/invalid/replicated).
This resolves Q29.

### 15.2 Intervention Test Suite

Ledger meanings MUST be validated behaviorally, not accepted from ledger prose
alone (resolves Q14). The mandatory suite, run during `evaluating`:

| Test | Procedure | Pass criterion (default) |
|---|---|---|
| Ablation | Drop a symbol/stroke-feature the ledger claims is meaningful | Receiver behavior changes in the ledger-predicted direction |
| Substitution | Swap a symbol for another in-inventory symbol | Receiver behavior shifts toward the substituted symbol's ledger-claimed meaning |
| Scrambling control | Replay with a shuffled post-hoc symbol-to-meaning mapping (offline analysis only, never live) | Ledger-predicted accuracy collapses toward chance, confirming the ledger is not a post-hoc rationalization |

Default descriptive readiness threshold: within each run, ledger-predicted direction
matches observed behavior change in at least 70% of probed instances. This is not an
inferential test. Confirmatory inference MUST account for probe clustering within
run/seed using a hierarchical Bernoulli model or a pre-registered seed-level
equivalent against the E03 chance baseline at alpha = 0.05.

### 15.3 Evaluation Baselines and Statistics

Resolves Q15. E03 (chance, no-communication, and random-message controls)
defines the chance baseline every later experiment compares against. Statistical
policy:

- pre-registered α = 0.05 per primary hypothesis;
- Holm-Bonferroni correction across the primary metrics of a single experiment;
- mandatory effect-size reporting (e.g., Cohen's h for proportions, rank-biserial
  for ordinal comparisons);
- minimum seeds: 5 per condition for qualification-stage experiments (E00-E03),
  10 per condition for any publication-facing claim (E10 onward).

Any conclusion that performance is equivalent to chance or that leakage is absent
MUST use a pre-registered equivalence/non-inferiority bound or Bayes-factor criterion
with power or sensitivity analysis. A non-significant difference alone cannot satisfy
a no-leakage or at-chance acceptance criterion.

Affect-channel leakage (§9.3) and cipher novelty-versus-security separation
(CONCEPT-IDEA.md §19.2, formalized below) use the same α and correction
policy.

### 15.4 Cipher Novelty and Security Reporting

E40 reports three dimensions separately:

1. **Artifact novelty:** whether the canonical protocol artifact hash and declared
   inputs are new relative to the project registry.
2. **Adversarial experimental result:** message-recovery performance for each
   pre-registered known and unseen Eve model.
3. **Cryptographic security:** `not-established` unless an independent expert review
   and formal security argument exist outside this experimental system.

A nonce, salt, unique artifact hash, or low recovery rate against one Eve model MUST
NOT change the third field. Learned encodings MUST NOT be imported into the production
hashing, signing, anchoring, authentication, or key-management packages. This
formalizes Q17 and the `cipherThreatModel` variable in §18.

### 15.5 Traceability to Experiment Notebook

See §17.4 for the full E00-E50 traceability table. Every experiment section in
EXPERIMENT-NOTEBOOK.md maps to a named configuration profile drawn from §18's
variable registry; this specification does not duplicate per-experiment
checklists already committed there.

## 16. UX Requirements

### 16.1 Dashboard and Research Console

Each twin (`baby-a`, `baby-b`, `nursery`) gets the standard DTSF per-twin
dashboard (MiniDash, Overview, Telemetry, Performance, Dataset, Test Runs,
Feedback, Console tabs), vanilla JS/HTML/CSS with no framework dependency,
consistent with existing DTSF dashboard conventions. The Nursery twin
additionally hosts a Research Console with:

- run configuration and pre-registration status;
- live transcript view (public artifacts only, never a Baby's private ledger
  content exposed to the other Baby's view, even in the human console's own
  layout — the console MUST render Baby A's and Baby B's perspectives as
  clearly separated panels, never merged);
- ledger convergence comparison (read-only, side-by-side, never fed back into a
  live run);
- checkpoint/anchor status with links to the independent chain explorer;
- pause/resume/abort controls gated to `researcher-operator`;
- verification-report status (pass/fail, last-run timestamp).

### 16.2 Diplomacy Table Reuse Boundaries

Reused, per CONCEPT-IDEA.md §19.5's mapping table:

| Diplomacy Table concept | Nursery Lab reuse |
|---|---|
| Delegation seat | Baby A / Baby B twin panel |
| Table / convener | Nursery Controller run driver |
| Operator view | `researcher-viewer`/`researcher-operator` console |
| Delegation perspective | One Baby's private observation/ledger panel |
| Round and tick | Exercise stage and turn |
| Transcript | Append-only channel/affect record |
| Tactic detection | Channel-violation/rejection detection |
| Recorded run and debrief | Replay, ledger comparison, causal-intervention report |

### 16.3 Prohibited UX Patterns

Caucuses, coalition rooms, direct delegation-to-delegation side links, and any
other secondary communication route from the Diplomacy Table MUST NOT be
reintroduced (resolves Q20). The console MUST NOT provide any control that lets a
human relay content from one Baby's panel into the other Baby's observation feed
during an active run outside of an explicitly logged, pre-registered
human-in-the-loop experimental condition.

## 17. Acceptance Criteria and Test Strategy

### 17.1 Acceptance Criteria

A phase/component is accepted only when:

- every applicable MUST in this document is satisfied and demonstrated by an
  automated test where feasible;
- the Verifier (§11.10) passes on a synthetic evidence bundle and correctly
  rejects every mutation case enumerated in LEDGER-INTEGRITY-DESIGN.md §17;
- the Replay Fidelity Test (§14.3) passes on at least one evaluation-phase run;
- Mode P and Mode R claim-boundary sentences (§5.1/§5.2) are reproduced verbatim
  in generated reports;
- the Intervention Test Suite (§15.2) is wired into the evaluation pipeline, even
  if a given experiment's results are still pending.

### 17.2 Test Strategy

| Layer | Test type | Example |
|---|---|---|
| Ledger/evidence | Unit + property tests | LEDGER-INTEGRITY-DESIGN.md §17 mutation matrix |
| Gateway | Unit + fuzz tests | Reject out-of-inventory symbols, oversized canvases, malformed affect payloads |
| Turn lifecycle | Integration tests | Atomic commit under simulated crash mid-transaction |
| Run state machine | Integration tests | Pause/resume/terminal abort, integrity-fork detection, and derived-run lineage (§7) |
| API surface | Contract tests | Route/role matrix (§12.2, §12.4-§12.6), error shape (§12.3) |
| Isolation | Mode R network-policy tests | Verify no route exists between Baby containers except via Gateway |
| Statistics/analysis | Notebook-bound tests | E03 chance-baseline reproducibility across seeds |

### 17.3 Phased Delivery

| Phase | Scope | Gate to next phase |
|---|---|---|
| Phase 0 | Repository scaffold + SQLite WAL + append-only local hash chains/signatures + Mode P lifecycle | Local integrity and crash-safety suite passes |
| Phase 1 | Merkle inclusion/consistency proofs + signed checkpoints + verifier + Base Sepolia + fixed-token Gateway + Scenario Engine + no-learning/control harness + Mode R red-team prerequisites | Software Gate G1 passes; E00-E03 may run |
| Phase 2 | Frozen-LLM, scratch-RL, self-supervised, and hybrid adapters + alternate carriers + Intervention Test Suite | Software Gate G2 passes; E10-E16 may run |
| Phase 3 | Six-display affect + RL-vs-non-RL and developmental-curriculum controls | Software Gate G3 passes; E20-E22 may run |
| Phase 4 | Derived-run lineage + partner transfer + drift + five interaction/utility profiles + Research Console maturity | Software Gate G4 passes; E30-E32 may run |
| Phase 5 | Ephemeral-encoding harness + Base mainnet opt-in + replication/publication bundle + optional Ethereum L1 batch root | Software Gate G5 passes; E40 and E50 may run |

### 17.4 Traceability to E00-E50

| Experiment | Primary specification sections exercised |
|---|---|
| E00 | §13 (Evidence Store, Merkle, anchoring), §11.10 (Verifier) |
| E01 | §5.2, §10.3 (Mode R isolation/side-channel controls) |
| E02 | §10.1, §10.2 (observation hygiene, prompt-injection controls) |
| E03 | §9.6 communication controls, §15.3 chance baselines, §6.1 `no-learning` track |
| E10 | §6.1 `frozen-llm`, §6.4/§6.6 learner contract |
| E11 | §6.1 `scratch-rl`, §6.2 adapter interface, §10.4 training isolation |
| E12 | §6.1 `self-supervised` |
| E13 | §9.2 alternate neutral carriers |
| E14 | §8.1 turn lifecycle, role reversal |
| E15 | §15.2 intervention/substitution testing (compositional generalization variant) |
| E16 | §15.2 Intervention Test Suite in full |
| E20 | §9.3 affect protocol |
| E21 | §6.1-§6.2 (all five learning-mechanism conditions), §11.9 experiment record |
| E22 | §18 `curriculumMode`, §4.3 BabySitter guidance boundary |
| E30 | §7.4 derived-run lineage and controlled partner replacement |
| E31 | §14.3/§14.4 (long-run replay/snapshot fidelity) |
| E32 | §9.5 interaction/utility profiles, with §16.2/§16.3 UX boundaries |
| E40 | §15.4 novelty/security reporting and §18 `cipherThreatModel` |
| E50 | §15.1 pre-registration binding, §17 acceptance criteria |

## 18. Experiment Variable Registry

Every choice CONCEPT-IDEA.md §21 flagged as research-dependent is a named,
defaulted, pre-registerable configuration variable, not an open question:

| Variable | Default | Range/values | Resolves |
|---|---|---|---|
| `deploymentMode` | `prototype` | `prototype`, `research-grade` | Q8 |
| `learnerTrack` (per Baby) | `scratch-rl` primary; `frozen-llm` for orchestration validation | `frozen-llm`, `scratch-rl`, `self-supervised`, `hybrid`, `no-learning` | Q1, Q11 |
| `symmetricTracks` | `true` | boolean | Q1 |
| `trainingIsolation` | `independent` | `independent`, `centralized` | Q11 |
| `learningSignal` | `extrinsic-task` for `scratch-rl`; `none` for frozen/no-learning; `self-supervised` for self-supervised | `none`, `extrinsic-task`, `intrinsic-social-influence`, `intrinsic-curiosity`, `intrinsic-prediction-progress`, `intrinsic-giddiness`, `self-supervised` | Q11, Q12 |
| `communicationCondition` | `normal` | `normal`, `disabled`, `constant`, `random`, `shuffled`, `oracle` | Q15 / E03 |
| `observationEncoding` | `opaque-numeric` | `opaque-numeric`, `pixel`, `hybrid-features` | Q2 |
| `carrierMode` | `fixed-token` | `fixed-token`, `fixed-glyph`, `generative-bitmap`, `generative-canvas`, `generative-tone` | Q3, Q4 |
| `symbolInventorySize` | `32` | 2-256 | Q5 |
| `maxSymbolsPerMessage` | `4` | 1-16 (hard ceiling) | Q5 |
| `maxStrokes` | `8` | 1-64 (hard ceiling) | Q4, Q5 |
| `affectMode` | `none` | `none`, `declared`, `permuted`, `opaque`, `derived`, `emergent` | Q13 |
| `affectWindowSchedule` | `post-outcome` | fixed enum, pre-registered | Q13 |
| `roleReversalPeriod` | `1` turn | ≥ 1 | — (supports Q19/Q26 progression design) |
| `ledgerLagTurns` | `0` | 0-2 | Q10 |
| `turnResponseBudgetMs` | `30000` | ≥ 1000 | Q6, §10.3 |
| `maxConsecutiveRejections` | `5` | ≥ 1 | Q6 |
| `checkpointEventInterval` | `64` | ≥ 1 | Q28 |
| `checkpointTimeIntervalMs` | `300000` | ≥ 1000 | Q28 |
| `anchorNetwork` | `base-sepolia` (dev), `base-mainnet` (public) | per LEDGER doc §10 | Q28 |
| `finalityPolicy` | `1-confirmation` (Sepolia), `safe-tag` (mainnet) | provider-dependent | Q28 (partially deferred, §19) |
| `interactionMode` | `cooperative-signaling` | `cooperative-signaling`, `asymmetric-information`, `semi-cooperative-negotiation`, `conflicting-negotiation`, `no-agreement-control` | Q19 |
| `cipherThreatModel` | `post-run-disclosure` | `post-run-disclosure`, `external-observer-only`, `novelty-only` | Q16, Q18 |
| `curriculumMode` | `fixed-schedule` | `fixed-schedule`, `adaptive-guided` (must be labeled) | Q26 |
| `interventionSuiteThreshold` | `0.70` | 0.0-1.0 | Q14 |
| `evaluationSeeds` | `5` (qualification), `10` (publication) | ≥ 1 | Q15 |
| `prototypeRetentionDays` | `30` | ≥ 0 (0 = purge disabled) | Q23 |

## 19. Deferred Decisions and ADRs

Only genuinely external, organization-dependent choices are deferred; every
research-methodology question above has a specified default instead.

| ID | Decision needed | Why it is deferred | Interim default |
|---|---|---|---|
| ADR-01 | Exact Base RPC provider(s) for submission and independent verification | Vendor/account/SLA choice outside this specification's authority | Any RPC provider satisfying: chain-ID confirmation, calldata/event retrieval, and block/finality-tag reporting; the Verifier MUST be provider-agnostic |
| ADR-02 | Anchor-wallet custody (self-hosted key vs. managed signer/HSM) | Organizational security-operations and budget decision | Self-hosted, dedicated, low-balance wallet for development; managed signer or hardware-backed key required before Base-mainnet public runs (LEDGER-INTEGRITY-DESIGN.md §11) |
| ADR-03 | Production hosting/runtime environment for Mode R containers | Infrastructure/vendor decision | Any container runtime enforcing the network-policy guarantees in §5.2/§10.3 |
| ADR-04 | Ethics/governance review process and named principal investigator | Institutional, not technical | EXPERIMENT-NOTEBOOK.md §4 fields remain `TBD` until an organizational decision is recorded there |
| ADR-05 | Final mainnet finality-tag semantics for the chosen provider | Depends on ADR-01 | `safe`-equivalent tag or provider-recommended confirmation depth, recorded in the run manifest once ADR-01 is resolved |
| ADR-06 | Public dataset/paper release licensing and redaction review process | Legal/publication policy, not architecture | Follow the existing repository `LICENSE` (MIT) for code; data-release licensing decided per EXPERIMENT-NOTEBOOK.md §12 publication checklist before any public dataset release |

## 20. Traceability: Resolution of the 29 Concept Questions

| # | CONCEPT-IDEA.md §21 question (paraphrased) | Resolved in |
|---|---|---|
| 1 | Initial Baby agent type and required additional types | §6.1 |
| 2 | Observations available and human-language label removal | §10.1 |
| 3 | Fixed symbol inventory vs. blank generative carrier baseline | §9.1, §9.2 |
| 4 | Neutral production grammar for new marks | §9.2 |
| 5 | Carrier bandwidth and message-length variation | §18 |
| 6 | What constitutes a prohibited human-language/side-channel attempt | §9.1, §9.4, §10.3 |
| 7 | BabySitter architecture (twin, twin+services, or subsystem) | §4.1, §4.2 |
| 8 | Isolation guarantees for prototype and research-grade modes | §5 |
| 9 | Ledger schema for English-capable and ungrounded agents | §11.4, §13.6 |
| 10 | Mandatory, atomic ledger updates with messages | §8.2 |
| 11 | Learning mechanisms for RL-vs-non-RL comparison; within-architecture feasibility | §6.1, §6.2 |
| 12 | Endogenous giddiness without covert BabySitter reward shaping | §4.3, §6.2, §18 (`learningSignal`) |
| 13 | Gateway enforcement of the six-display affect protocol | §9.3 |
| 14 | Intervention tests establishing behaviorally real ledger meanings | §15.2 |
| 15 | Evaluation baselines, chance levels, statistical thresholds | §15.3 |
| 16 | Threat model for ephemeral cipher experiments | §18 (`cipherThreatModel`) |
| 17 | Separating cipher novelty from cryptographic security | §15.4 |
| 18 | When cipher ledgers/keys may be hidden from the BabySitter | §18 (`cipherThreatModel: post-run-disclosure`) |
| 19 | Coordination game vs. convention formation vs. negotiation baseline | §9.5, §18 (`interactionMode`) |
| 20 | Which Diplomacy Table behaviors/UX are reusable without caucuses | §16.2, §16.3 |
| 21 | Snapshots, hashes, policy checkpoints, and replay | §14.3, §14.4 |
| 22 | Controls governing human observation and intervention | §14.2 |
| 23 | Data retention, privacy, safety, and termination policies | §14.6 |
| 24 | Learner-contract versioning, testing, and semantic-example freedom | §6.4 |
| 25 | Converting agent-native state to a human audit ledger without feedback | §13.6 |
| 26 | Competence gates and guided-curriculum labeling | §4.3, §18 (`curriculumMode`) |
| 27 | Model-selection and semantic-leakage tests across tracks | §6.5 |
| 28 | Checkpoint cadence, finality, Base anchor, key management, verifier | §13.3, §13.4, §13.5, §11.10 |
| 29 | Binding pre-registration, deviations, invalid runs, and replication to evidence | §15.1 |

---

This specification is implementation-ready for Phase 0 (§17.3) as of the date of
its commit. Amendments MUST follow the same protocol-amendment discipline as
EXPERIMENT-NOTEBOOK.md §3: record the change, apply it to new runs, and never
silently reinterpret an already-sealed run's evidence.
