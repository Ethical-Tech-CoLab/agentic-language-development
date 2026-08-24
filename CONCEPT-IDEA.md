# DTSF Nursery Lab - Emergent Agent Language Concept

> **Document type:** Concept and idea exploration
>
> **Status:** Pre-specification
>
> **Intent:** Establish the purpose, boundaries, research questions, and proposed
> architecture for a future implementation specification.

## 1. Concept Summary

The DTSF Nursery Lab is an experimental environment in which two isolated agents,
called **Baby A** and **Baby B**, attempt to develop a shared language through repeated
interaction.

Each Baby is represented by its own DTSF digital twin. The Babies can communicate
with one another only through a controlled chat channel created and supervised by a
third agent, the **BabySitter**. The channel accepts only symbols from an experiment-
specific vocabulary. It does not permit English or any other established human
language.

The Babies learn through shared experiences rather than through a supplied
dictionary. They encounter objects, attributes, relationships, actions, and outcomes;
exchange symbols; observe whether their collaboration succeeds; and independently
record how they believe the meaning of each symbol or construction is evolving.

The central idea is:

> Two isolated agents develop a grounded, auditable symbolic protocol through
> cooperative experience while a third agent observes without teaching or
> translating the protocol.

The experiment is intended to make emergent communication inspectable. It should
produce not only a transcript of what the Babies said, but also two independent,
chronological accounts of how each Baby inferred, revised, and eventually stabilized
the meaning of the language.

## 2. Purpose of This Document

This document prepares the concept for a later specification. It describes:

- the research premise;
- the roles of Baby A, Baby B, and the BabySitter;
- the need for shared, nonverbal experiences;
- the controlled communication boundary;
- the independent language ledgers;
- possible learning loops and experimental stages;
- meaningful measures of success;
- caveats, risks, and unresolved design questions.

This document is intentionally not an API contract, security specification, model
selection, data schema, or implementation plan. Those details should be resolved in
the follow-on specification.

## 3. Research Premise

The experiment asks whether two agents can converge on a useful common language when:

1. neither agent receives a predefined meaning for the available symbols;
2. neither agent can send human language to the other;
3. the only practical communication path between them is a controlled symbol channel;
4. both agents receive evidence from shared tasks and outcomes;
5. each agent maintains its own private interpretation history;
6. a supervising agent and human researchers can audit the full process.

The desired result is not merely a substitution cipher in which a random token stands
for an English word already selected in advance. The stronger result would be a
grounded protocol whose vocabulary and grammar arise because they help the Babies
solve tasks together.

Questions the Nursery Lab could investigate include:

- How quickly can two agents establish stable symbol meanings?
- Do they develop symbols for objects first, or for actions and outcomes?
- Do multi-symbol constructions become compositional?
- Do the two private ledgers converge even though the Babies cannot read one another's
  ledgers?
- How do meanings drift over long interactions?
- Do repair, confirmation, negation, or uncertainty signals emerge?
- Can a learned language generalize to situations the Babies have not previously
  encountered?
- How does emergent communication differ across agent architectures and learning
  methods?

## 4. Important Caveat: What "Infant-Like" Means

The analogy to two babies learning together is useful, but it has limits.

Baby A and Baby B may be implemented with agents that can read and write English.
Pretrained language models already contain extensive human-language knowledge and
cannot honestly be described as language-naive. Restricting their external channel
does not remove the linguistic concepts or reasoning patterns already encoded in
their parameters.

For those agents, the experiment studies the emergence of a **new shared external
protocol**, not the origin of language in minds that have never learned one. The
Babies may reason internally or write their private ledgers in English, but English
must never cross from one Baby to the other.

The Nursery Lab should therefore support multiple agent types, including:

- pretrained language-model agents that already know human languages;
- agents with persistent memory but no parameter training during a run;
- agents whose policies can be updated through reinforcement learning;
- agents with trainable adapters or other parameter-efficient learning;
- initially ungrounded trainable agents that do not begin with a human-language
  semantic system.

Experiments and conclusions must identify which kind of agent was used. Results from
pretrained language-model agents must not be presented as equivalent to language
acquisition by initially ungrounded agents.

The infant-like aspect of the concept is best understood as the combination of:

- learning through repeated shared experience;
- establishing joint attention;
- receiving consequences from successful or failed interaction;
- revising provisional meanings over time;
- developing conventions with a recurring communication partner.

It is not a claim that the cognitive conditions are identical to those of human
infants.

## 5. Goals and Non-Goals

### 5.1 Goals

- Enable two agents to develop a shared symbolic communication system.
- Prevent human language from being used in Baby-to-Baby communication.
- Make the controlled channel the only practical path between the Babies.
- Ground communication in tasks, actions, observations, and outcomes.
- Preserve independent, append-only accounts of inferred meaning.
- Give the BabySitter complete visibility into channel activity and ledger evolution.
- Make experiments replayable, measurable, and auditable by humans.
- Support comparisons across multiple agent and training types.
- Distinguish memorized conventions from compositional generalization.
- Produce enough architectural and research clarity to write an implementation
  specification next.

### 5.2 Non-Goals

- Claiming that pretrained language models are truly language-naive.
- Reproducing the complete cognitive or social development of human infants.
- Allowing the BabySitter to secretly translate, teach, or reconcile the language.
- Treating an opaque transcript as sufficient evidence of understanding.
- Relying on prompt instructions alone to enforce communication isolation.
- Proving the absolute absence of every possible physical or computational side
  channel in the initial prototype.
- Defining final APIs, storage formats, deployment topology, or model vendors in this
  concept document.

## 6. Proposed Roles

### 6.1 Baby A Twin

Baby A has:

- private observations permitted by the current exercise;
- a private memory and learning policy;
- a private, chronological language ledger;
- the ability to emit only permitted channel symbols;
- no access to Baby B's state, observations, ledger, tools, or direct endpoints.

### 6.2 Baby B Twin

Baby B has the same capabilities and restrictions as Baby A, but its state, memory,
learning process, and ledger remain independent.

The two Babies may use different model or agent types in comparative experiments,
although symmetric pairings should be the baseline.

### 6.3 BabySitter / Nursery Twin

The BabySitter is the supervising agent. The Nursery is the controlled environment
and orchestration capability it operates.

The BabySitter:

- establishes and administers the permitted chat channel;
- creates or selects shared exercises;
- sends each Baby only its allowed observation;
- has full read access to channel messages and both ledgers;
- records actions, rewards, outcomes, and experimental conditions;
- detects policy violations and can pause or terminate a run;
- creates snapshots and audit reports;
- compares ledger convergence without exposing either ledger to the other Baby;
- does not provide translations or semantic hints during an active experiment.

The BabySitter should not be the security boundary. Deterministic runtime code must
validate and broker every message. An observing agent can make supervisory decisions,
but prompt compliance alone is not sufficient isolation.

### 6.4 Human Researcher

A human researcher can configure experiments, inspect transcripts and ledgers, review
alerts, run intervention tests, and interpret results. Human access must be recorded so
that intervention during a run is distinguishable from passive observation.

## 7. Conceptual Architecture

```text
                  shared tasks and outcomes
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

          Baby A private ledger   Baby B private ledger
                    \              /
                     read-only audit
                     for BabySitter
```

The concept uses three DTSF twins:

- one twin for Baby A;
- one twin for Baby B;
- one Nursery/BabySitter twin for orchestration, supervision, and audit.

A separate deterministic **Symbol Gateway** owns channel validation and message
delivery. In a prototype, this may be a runtime service used by the Nursery. In a
stronger isolation model, it should be the only network-reachable broker between
separately hosted Baby processes or containers.

## 8. The Necessary Ingredient: Shared Experience

A chat channel alone cannot reliably ground meaning. The Babies need common events
that provide evidence about what a symbol might mean.

The Nursery should present nonverbal or machine-structured situations such as:

- colored shapes in different positions;
- one Baby seeing a target that the other must select;
- placing an object in a requested location;
- ordering a sequence of objects;
- exchanging resources;
- cooperating to unlock a reward;
- observing whether the partner's action succeeded or failed.

For example:

1. Baby A sees that a red circle is the target.
2. Baby B sees several objects but is not told which one is the target.
3. Baby A sends one or more permitted symbols.
4. Baby B selects an object.
5. Both Babies receive a success or failure outcome.
6. Both update their private hypotheses.

Repeated trials with controlled variation provide evidence. If a symbol is reused
across a red circle, red square, and red triangle, Baby B may revise its hypothesis
from "red circle" to "red." Novel combinations are especially important because they
help distinguish a compositional language from memorized whole-scene codes.

Observations supplied to the Babies should avoid human-language labels. An object
should be represented by pixels, features, coordinates, opaque identifiers, or another
experiment-approved encoding rather than a field such as `"color": "red"` when the
purpose is to study grounding.

## 9. Controlled Symbol Channel

The Symbol Gateway is the only permitted Baby-to-Baby communication route. The
channel is proprietary in the sense that it is owned and controlled by the Nursery,
not in the sense that its security depends on a secret protocol.

Each run begins with an experiment-specific symbol inventory that has no supplied
meaning, for example `S01` through `S32`. A Baby can choose only a sequence of symbols:

```json
{ "symbols": ["S13", "S04"] }
```

The gateway, not the Baby, adds trusted metadata:

```json
{
  "runId": "run-42",
  "turn": 18,
  "sender": "baby-a",
  "symbols": ["S13", "S04"],
  "previousHash": "...",
  "hash": "..."
}
```

Conceptual channel controls include:

- reject English and every other established human language;
- reject arbitrary Unicode prose, URLs, attachments, and tool calls;
- accept only symbols from the run's fixed inventory;
- limit message length and symbol repetition;
- use server-assigned sender identity, turn number, timestamp, and message ID;
- enforce turn order, time budgets, and rate limits;
- preserve an append-only, hash-chained transcript;
- prevent direct access to the other Baby's endpoints, state, ledger, or logs;
- prevent shared filesystem, environment, memory, and unrestricted network access;
- normalize timing, message size, errors, and scheduling where practical;
- record every rejected communication attempt for audit.

The specification will need to define how channel validation identifies human
language. A fixed token grammar is stronger than attempting to detect prohibited prose
after it has been generated.

## 10. Isolation and Side-Channel Caveat

A claim that no side channel exists is difficult to prove. Babies sharing a host might
signal through timing, resource contention, shared files, error behavior, identifiers,
or services not intended as communication mechanisms.

For an early DTSF prototype, isolated twin state maps may be sufficient to explore the
learning loop. They are not a hard security boundary because twin behavior executes
inside the same runtime process.

For experiments intended to support a credible channel-isolation claim:

- run Baby A and Baby B in separate worker processes or containers;
- deny direct network routes between them;
- expose only the Nursery-owned Symbol Gateway;
- avoid shared writable storage;
- use fixed turn schedules and bounded response windows;
- normalize externally observable errors and response sizes;
- inventory and disable unnecessary tools;
- audit all broker, runtime, and operator activity.

The future specification should define the threat model and the strength of isolation
claimed for each deployment mode.

## 11. Independent Language Ledgers

Each Baby must maintain its own language ledger. The ledger is mandatory, private from
the other Baby, visible to the BabySitter and authorized human auditors, and ordered by
the sequence in which terms and constructions are first encountered.

The ledger is not a shared dictionary. It is an evolving record of one Baby's
provisional beliefs. The two ledgers must never be directly reconciled by the Babies.

### 11.1 Two- or Three-Column Ledger

The ledger must use a compact two- or three-column chronological structure. A
two-column implementation may combine the hypothesis and its evidence, but it must
still preserve the complete revision history. The preferred concept uses three
columns:

| Sequence and term | Current definition or hypothesis | Evidence and evolution |
|---|---|---|
| 1 - `S13` | red circle; confidence 0.45 | First received while the red circle was the target; selection succeeded |
| 8 - `S13` | red; confidence 0.78 | A red square was selected successfully; revised from object identity to color |
| 22 - `S13` | red; confidence 0.94 | Prediction held across circles, squares, and triangles |

The sequence value identifies when the interpretation was first recorded or revised.
Multiple rows for the same term preserve its chronological evolution. The same format
can record multi-symbol constructions, such as a hypothesis that `S13 S04` means
"color followed by shape."

### 11.2 Ledger Rules

1. First emission or receipt of an unfamiliar term requires a first-use entry.
2. Definitions are provisional hypotheses, not retroactively asserted facts.
3. Every meaning change appends a revision; previous interpretations are not
   overwritten.
4. Entries may describe symbols, sequences, ordering, grammar, repair signals, or
   other constructions.
5. Entries record confidence, supporting evidence, contradictory evidence, and
   abandoned meanings.
6. A Baby records its intended meaning when speaking and its inferred meaning when
   receiving.
7. A channel message and its required private ledger mutation should be committed
   atomically.
8. Ledger entries include enough run and turn references to trace them to observable
   evidence.
9. Neither Baby can query, receive, summarize, or infer from the other Baby's ledger
   through a system-provided interface.

The Babies may write their private ledgers in English for human audit, even though
they cannot send that English to one another. For initially ungrounded agents that
cannot produce English explanations, the environment may generate a separate
researcher-facing interpretation from their internal policy state. Such generated
interpretations must be labeled as analysis rather than as the agent's own explanation.

## 12. Proposed Learning Loop

1. The Nursery creates a scenario and records its ground truth.
2. The Nursery independently sends each Baby only its permitted observation.
3. The designated sender chooses a symbol sequence and records its private intended
   hypothesis.
4. The Symbol Gateway validates the sequence and forwards only permitted symbols.
5. The receiver records its interpretation before responding or acting.
6. The Nursery executes or evaluates the selected action.
7. Both Babies receive the approved nonverbal outcome or reward.
8. Each Baby independently updates its ledger and learning state.
9. The Nursery snapshots the scenario, observations, messages, actions, outcome,
   training state, and both ledger versions.
10. Speaking and listening roles reverse regularly so that neither Baby has a
    permanently privileged role.

For a memory-based MVP, "learning" can mean persistent episodic memory and updates to
a symbol-to-concept policy. Conversation alone does not modify model weights.
Parameter-level learning requires an explicit training mechanism, such as
reinforcement learning or adapters updated between batches.

## 13. Experimental Progression

The Nursery can increase difficulty in stages:

1. **Naming:** Four distinct objects and one-symbol messages.
2. **Attributes:** Novel combinations of colors, shapes, sizes, or textures.
3. **Relations:** Left/right, above/below, inside/outside, and near/far.
4. **Actions:** Select, move, exchange, wait, repeat, or stop.
5. **Composition:** Multi-symbol messages that distinguish attributes and roles.
6. **Grammar:** Order-sensitive or role-sensitive constructions.
7. **Repair:** Ambiguous scenes that reward confirmation, correction, or uncertainty.
8. **Generalization:** Unseen combinations with learning disabled during evaluation.
9. **Drift:** Long-running sessions that reveal whether meanings remain stable.
10. **Cross-architecture comparison:** Repeat equivalent exercises with different
    agent and training types.

The progression should control task complexity, available vocabulary, number of
turns, reward structure, and exposure history so that results can be compared.

## 14. What Should Count as Success

Evidence of a successful emergent protocol should include:

- task performance on held-out situations substantially above chance;
- no human-language content in Baby-to-Baby communication;
- compatible meanings emerging in the independently written ledgers;
- generalization to unseen combinations rather than memorization of entire scenes;
- stable use of symbols across role reversals;
- a human auditor being able to predict behavior from the transcript and ledgers;
- masking, substituting, or reordering a symbol changing behavior in the way its
  ledger predicts;
- replay from an equivalent snapshot reproducing the relevant language history;
- an unbroken audit trail from first use through every revision of a symbol or rule.

Ledger fluency alone is not proof. A persuasive ledger could be a post-hoc explanation
rather than a faithful account of the policy that produced the behavior. Intervention
tests are therefore necessary.

Potential measurements include:

- success rate and improvement over time;
- turns required to reach a stable convention;
- vocabulary size and symbol entropy;
- sender/receiver consistency;
- divergence and convergence between the two ledgers;
- compositional generalization score;
- meaning drift rate;
- recovery from ambiguity or deliberate perturbation;
- prohibited-channel attempt count;
- reproducibility across seeds and agent pairings.

## 15. Auditability and Reproducibility

Each run should preserve:

- agent type, model identity, model version, and training mode;
- system instructions and permitted tools;
- symbol inventory and gateway rules;
- random seeds and scenario configuration;
- private observations delivered to each Baby;
- accepted and rejected channel messages;
- actions, rewards, and outcomes;
- both append-only ledgers;
- learning or policy checkpoints where applicable;
- BabySitter and human interventions;
- runtime and deployment topology;
- snapshots sufficient for replay.

This evidence allows researchers to separate genuine learning from prompt leakage,
hidden shared context, accidental human-language transfer, or irreproducible model
behavior.

## 16. Preliminary DTSF Shape

The follow-on specification may consider unprefixed Baby routes such as:

- `POST /observe`
- `POST /speak`
- `POST /interpret`
- `POST /outcome`
- `GET /ledger`
- `POST /reset`

It may consider Nursery routes such as:

- `POST /runs`
- `POST /runs/:id/step`
- `GET /runs/:id/transcript`
- `GET /runs/:id/ledgers`
- `GET /runs/:id/audit`
- `POST /runs/:id/pause`

Relevant state concepts include:

- runs and experimental configurations;
- scenarios and ground truth;
- private observations;
- channel messages and validation results;
- actions, rewards, and outcomes;
- chronological ledger revisions;
- agent and training checkpoints;
- immutable snapshots and audit records.

These routes and records are illustrative, not yet requirements.

## 17. Risks and Research Integrity

### 17.1 Human-Language Leakage

English can leak through observations, object labels, error messages, identifiers,
tool output, metadata, or timing conventions even when ordinary chat text is blocked.
The specification must treat every input and output surface as part of the channel
boundary.

### 17.2 Pretrained Semantic Leakage

Random symbols do not make a pretrained model ungrounded. Experiments must clearly
state whether the result is protocol invention by a language-capable agent or language
acquisition by an initially ungrounded trainable agent.

### 17.3 Ledger Rationalization

A model may write a plausible explanation that does not represent the mechanism used
to choose its action. Behavioral interventions, policy probes, and temporal evidence
must validate ledger claims.

### 17.4 BabySitter Influence

The BabySitter can unintentionally teach through scenario ordering, feedback wording,
reward design, or selective intervention. Its permitted actions should be constrained
and logged. Evaluation scenarios should be generated independently where possible.

### 17.5 Reward Exploitation

Trainable agents may find shortcuts that improve reward without creating the intended
grounded language. Held-out tasks, counterfactual trials, and channel audits should
test for these shortcuts.

### 17.6 Overstated Security

Logical DTSF state separation is appropriate for prototyping but should not be
described as hard process isolation. Every experimental result should name the
isolation level actually used.

## 18. Decisions for the Future Specification

The specification should resolve at least the following:

1. What is the initial Baby agent type, and which additional types must the platform
   support?
2. What observations are available, and how are human-language labels removed?
3. What is the initial symbol inventory and message grammar?
4. How are symbol inventory size and message length varied across experiments?
5. What constitutes a prohibited human-language or side-channel attempt?
6. Is the BabySitter one DTSF twin, a twin plus deterministic services, or a broader
   orchestration subsystem?
7. What isolation guarantees are required for prototype and research-grade modes?
8. What exact ledger schema supports both English-capable and initially ungrounded
   agents?
9. How are ledger updates made mandatory and atomic with messages?
10. What learning mechanisms are supported during and between runs?
11. How are rewards designed without implicitly teaching a vocabulary?
12. Which intervention tests establish that ledger meanings are behaviorally real?
13. What evaluation baselines, chance levels, and statistical thresholds apply?
14. How are snapshots, hashes, policy checkpoints, and replay implemented?
15. What controls govern human observation and intervention?
16. What data retention, privacy, safety, and experiment-termination policies apply?

## 19. Desired Specification Outcome

The next document should convert this concept into a testable system specification
that defines:

- component boundaries and deployment modes;
- DTSF twin manifests and behavior responsibilities;
- Symbol Gateway protocol and enforcement;
- observation, task, reward, and training interfaces;
- ledger and audit schemas;
- state transitions and run lifecycle;
- security and side-channel threat models;
- experimental stages and agent compatibility;
- evaluation metrics and acceptance criteria;
- reproducibility, snapshot, and evidence requirements;
- implementation phases from prototype to research-grade isolation.

The specification should preserve the core principle: Baby A and Baby B may possess
human-language abilities internally, but they must develop their shared external
language without sending human language, translations, or private ledger contents to
one another.
