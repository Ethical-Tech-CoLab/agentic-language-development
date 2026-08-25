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

## 18. Research Landscape

### 18.1 Method and Scope

This initial research scan was performed on August 24, 2026 using the Tavily Search
and Extract APIs. Queries covered emergent multi-agent communication, referential
games, compositionality, causal evaluation, intrinsic motivation, graphical symbol
invention, negotiation, learned cryptography, per-message keys, nonces, and salts.
Primary papers and authoritative specifications were preferred over summaries.

This is a scoped literature review for concept development, not a systematic review.
Publication-quality work should verify the final bibliography, expand the search
across additional scholarly indexes, and document inclusion and exclusion criteria.

### 18.2 Emergent Communication and Grounding

Selected work establishes that artificial agents can develop useful communication
protocols, but also shows why task success alone is not evidence of language-like
understanding.

| Related work | Relevant finding | Implication for the Nursery Lab |
|---|---|---|
| [Multi-Agent Cooperation and the Emergence of (Natural) Language](https://arxiv.org/abs/1612.07182), Lazaridou, Peysakhovich, and Baroni (2017) | A sender and receiver can develop a grounded protocol in a referential game without receiving a target language. | The proposed Naming stage has a strong experimental precedent, but a fixed vocabulary remains an important inductive constraint. |
| [Emergence of Grounded Compositional Language in Multi-Agent Populations](https://arxiv.org/abs/1703.04908), Mordatch and Abbeel (2018) | Multi-agent goals in a grounded environment can produce multi-symbol communication with partial compositional structure. | Shared objects, actions, and goals are a stronger basis for language emergence than an ungrounded chat transcript. |
| [Natural Language Does Not Emerge 'Naturally' in Multi-Agent Dialog](https://arxiv.org/abs/1706.08502), Kottur, Moura, Lee, and Batra (2017) | Agents can solve a task with a degenerate or non-compositional code; structural constraints materially affect what emerges. | Channel bandwidth, memory, turn structure, and task design must be experimental variables rather than hidden implementation choices. |
| [Compositionality and Generalization in Emergent Languages](https://aclanthology.org/2020.acl-main.407/), Chaabouni, Kharitonov, Bouchacourt, Dupoux, and Baroni (2020) | Generalization to novel combinations and measured compositionality can dissociate. | The Nursery must test held-out behavior directly and must not use a single compositionality score as proof of understanding. |
| [Learning to Draw: Emergent Communication through Sketching](https://arxiv.org/abs/2106.02067), Mihai and Hare (2021) | Neural agents can communicate through learned drawings rather than a supplied discrete vocabulary. | A blank visual canvas is a credible carrier for experiments in which no symbol library is provided. |
| [Sharp Transition Towards Shared Vocabularies in Multi-Agent Systems](https://arxiv.org/abs/physics/0509075), Baronchelli, Felici, Caglioti, Loreto, and Steels (2005) | Naming Game agents can converge on a shared vocabulary through local interaction without a central teacher. | Vocabulary convergence time, failed conventions, and memory update rules should be recorded as first-class evidence. |

This literature also reinforces the infant-like caveat. Most modern experiments give
agents substantial structure: a fixed channel, a task objective, a bounded vocabulary,
joint training, or a reward signal. "No dictionary" does not mean "no inductive bias,"
and "no teacher" does not mean "no learning signal."

### 18.3 Evaluation and Causal Evidence

[On the Pitfalls of Measuring Emergent Communication](https://arxiv.org/abs/1903.05168)
by Lowe, Foerster, Boureau, Pineau, and Dauphin (2019) distinguishes **positive
signaling** from **positive listening**. A sender may emit messages correlated with its
observations while the receiver does not causally use those messages. The authors
recommend interventions rather than relying only on task reward or transcript
statistics.

[Interpretable Agent Communication from Scratch](https://arxiv.org/abs/2106.04258)
by Dessi, Kharitonov, and Baroni (2021) provides a close precedent for the Nursery's
proposed symbol-ablation and substitution tests. A credible audit should demonstrate
that changing a symbol changes the receiver's behavior in the direction predicted by
the ledgers.

[EGG: a Toolkit for Research on Emergence of Language in
Games](https://arxiv.org/abs/1907.00852) by Kharitonov, Chaabouni, Bouchacourt, and
Baroni (2019) is useful implementation prior art for repeatable referential games,
channel controls, checkpoints, metrics, and transcript logging. DTSF need not adopt
the toolkit, but the future specification should compare its evidence model against
the practices EGG supports.

### 18.4 Intrinsic Motivation and Affect

[Social Influence as Intrinsic Motivation for Multi-Agent Deep Reinforcement
Learning](https://proceedings.mlr.press/v97/jaques19a.html) by Jaques and colleagues
(2019) rewards an agent for causally influencing another agent's behavior. The work
shows that an endogenous social-influence signal can improve coordination and learned
communication without assigning a vocabulary.

This is relevant to the idea of a Baby becoming "giddy" when interaction is engaging
or successful. However, the Tavily search found a thinner body of work connecting
explicit emotional displays, such as emojis, to the emergence of a new agent language.
That makes affective feedback a genuine experimental contribution rather than an
already settled design pattern.

### 18.5 Negotiation and the Diplomacy Table

[Emergent Communication through
Negotiation](https://arxiv.org/abs/1804.03980) by Cao, Lazaridou, Lanctot, Leibo,
Tuyls, and Clark (2018) studies a semi-cooperative negotiation environment with both
grounded communication and initially ungrounded cheap talk. It shows that
self-interest, shared interest, and the reward structure affect whether communication
becomes informative.

The existing [Diplomacy Table](https://github.com/Ethical-Tech-CoLab/diplomacy-table-live)
is also direct project prior art. It already models:

- independent delegation seats;
- a table or convener that advances rounds;
- operator-wide visibility and delegation-specific perspectives;
- channels, transcripts, ticks, and redaction boundaries;
- recorded replay and post-session debrief.

These concepts map well to Baby A, Baby B, the BabySitter, controlled turns, private
observations, and replayable evidence. Caucuses, coalitions, and hidden secondary
channels do not map safely and would need to be disabled.

### 18.6 Learned and Ephemeral Cryptography

[Learning to Protect Communications with Adversarial Neural
Cryptography](https://arxiv.org/abs/1610.06918) by Abadi and Andersen (2016) shows that
Alice and Bob neural networks can learn to protect a message from an adversarial Eve
network when Alice and Bob possess a shared secret key. It is relevant proof that
learned protective encodings can emerge, but it is not a replacement for formal
cryptographic security analysis.

Established secure messaging normally keeps the algorithm stable and changes secret
key material. The [Signal Double Ratchet
specification](https://signal.org/docs/specifications/doubleratchet/) derives a unique
message key for each message and deletes keys after use. This directly addresses
history and key-reuse risks without inventing a new cipher algorithm for every
message.

NIST defines a [nonce](https://csrc.nist.gov/glossary/term/nonce) as a value used only
once within a specified context and a [salt](https://csrc.nist.gov/glossary/term/salt)
as a usually non-secret value used to prevent results from one instance being reused
against another. A nonce or salt can help make an experiment instance distinct. It
does not prove that a newly generated cipher is secure, non-equivalent to earlier
ciphers, or resistant to cryptanalysis.

### 18.7 Research Conclusions for the Specification

The reviewed work suggests the following:

1. The Nursery Lab is related to a mature emergent-communication research field, but
   its independent ledgers, BabySitter audit, mixed agent types, and affect experiments
   create a distinctive combination.
2. Grounding, channel bandwidth, memory, and learning pressure strongly shape what
   language emerges.
3. Successful coordination can coexist with a brittle lookup code or with messages
   the receiver ignores.
4. Causal symbol interventions and held-out generalization tests are mandatory.
5. A visual or gestural carrier can remove the need for a predefined symbol library,
   but no experiment can remove the need for some physical or computational carrier.
6. Intrinsic social influence is a plausible substitute for task-specific external
   reward, but it remains a designed learning bias.
7. Negotiation is a valid advanced experimental condition, not necessarily the
   correct description of the baseline cooperative language game.
8. Ephemeral language conventions, learned cryptography, one-time pads, per-message
   keys, nonces, and salts are different mechanisms and must not be conflated.

## 19. Experimental Ideas

### 19.1 Emojis and Affective Feedback

**Hypothesis:** A low-bandwidth affect channel can help one Baby tell the other how an
interaction feels, providing social feedback that supports repair, trust, repetition,
or avoidance.

The default declared affect palette should be limited to exactly six displays:

| Affect ID | Display | Declared meaning |
|---|---|---|
| `A1` | `😀` | Happy |
| `A2` | `😞` | Sad |
| `A3` | `😆` | Laughing |
| `A4` | `😢` | Crying |
| `A5` | `😕` | Confused |
| `A6` | `😮` | Surprised |

The affect IDs and English labels are gateway-internal documentation and are never
sent to either Baby. A Baby receives only the single rendered display.

No other emoji, reaction, Unicode pictograph, skin-tone modifier, variation, custom
emoji, or combined glyph is available to either Baby.

Emojis introduce an immediate caveat: pretrained language models already know their
human cultural meanings. A Baby using `😀` is not inventing a symbol for happiness.
The palette is supplied feedback vocabulary and must be explicitly outside the
emergent language.

Constraining the vocabulary is necessary but not sufficient. Six displays still form
a six-symbol alphabet capable of carrying approximately 2.6 bits in each use. Across
multiple turns, the Babies could repurpose even this small palette as a second
language. The gateway must therefore constrain the channel itself:

1. The affect display occupies a separate typed field and can never appear inside a
   symbol message.
2. The gateway opens an affect window only after a defined action or outcome, never at
   an arbitrary point selected by a Baby. Window frequency is fixed before the run;
   neither Baby can request extra opportunities.
3. Exactly one allowlisted display is delivered in the window. There are no sequences,
   repetitions, combinations, modifiers, or custom forms.
4. Delivery time, envelope size, and presentation are normalized so timing and message
   shape do not add another signal.
5. The receiving Baby cannot reply through the affect channel until the next
   gateway-defined feedback window.
6. The gateway rejects and audits every non-allowlisted code point or malformed affect
   payload.
7. Analysis tests whether affect choices correlate with objects, actions, or message
   meanings after controlling for the stated emotional context. Unexpected correlation
   is treated as suspected channel leakage.

The no-affect condition remains the primary control. Affect experiments should then
compare:

1. **Six-display declared affect:** The fixed palette above is supplied, semantically
   declared, and subject to the strict feedback-window contract.
2. **Six-display permuted affect:** The same six visible displays are randomly mapped
   to affect states for each run. A pretrained model may still be biased by the
   familiar glyphs.
3. **Opaque affect tokens:** Six unfamiliar shapes replace the familiar emojis while
   preserving the same feedback-window constraints.
4. **Derived affect:** The gateway maps a Baby's separately measured internal affect
   state to one display instead of allowing an unconstrained message choice.
5. **Emergent affect:** A separate experiment permits invented graphical displays.
   Because this creates another generative language channel, it does not use the
   constrained emoji contract and must be analyzed as language emergence.

Any affect signal visible to the other Baby is communication and must appear in the
ledger. The ledger should distinguish:

- the Baby's private internal state;
- the outward affect display it chose;
- the partner's inferred meaning;
- evidence that the display changed subsequent behavior.

Useful comparisons include convergence speed with and without affect, repair after a
failed exchange, frequency of repeated attempts, trust or approach behavior, and
whether the fixed affect channel leaks task or referent information beyond its
declared purpose.

### 19.2 Verifiably Unique Ephemeral Cipher Instances

**Hypothesis:** Two agents may be able to construct a new one-run or one-message
encoding convention that cannot be attacked using a direct history of prior
conventions.

This idea should be split into three different experiments:

1. **Ephemeral convention:** The Babies invent a temporary codebook or transformation
   for synthetic messages. This tests novelty, coordination, and resistance to a
   history-trained classifier. It does not establish cryptographic security.
2. **Standard cryptographic control:** The same messages use a reviewed algorithm
   with a fresh per-message key, such as a ratcheting construction. This provides a
   security baseline against which learned encodings can be compared.
3. **Adversarial neural cryptography:** Baby A and Baby B learn an encoding while an
   Eve agent attempts to recover the message. Success is measured against multiple
   unseen Eve architectures, not only the adversary used during training.

An experimental cipher instance could receive a reproducible identity such as:

```text
instanceId = SHA-256(
  runId || babyANonce || babyBNonce || publicSalt || canonicalProtocolArtifact
)
```

Baby A and Baby B could commit to their nonce contributions before revealing them so
neither party alone controls the final instance identity. A registry can verify that
an `instanceId` has not appeared in an earlier run.

This proves only that the recorded inputs or artifact hash are new. It does not prove:

- that the effective algorithm is behaviorally different from an earlier one;
- that the algorithm has no structural weakness;
- that the key is unpredictable;
- that the scheme provides confidentiality, integrity, authenticity, forward secrecy,
  or resistance to a stronger adversary.

A salt is normally public diversification data, not secret key material. A nonce must
be unique in the context required by the selected cryptographic construction. Neither
should be described as making a cipher secure by itself.

There is also a conceptual conflict to resolve. The BabySitter has full channel and
ledger visibility, while a mandatory ledger documents how meaning evolved. If the
ledger explains decryption, the cipher is not confidential from the BabySitter or
human auditor. The future specification must choose a threat model, for example:

- resist only an external observer who sees prior runs;
- resist an Eve agent during the run while releasing keys and ledgers afterward;
- keep the BabySitter able to pause traffic but unable to decrypt it until a post-run
  audit ceremony;
- study novelty rather than confidentiality and avoid calling the result encryption.

All cipher experiments must use synthetic, non-sensitive messages. No learned or
newly invented algorithm should protect real secrets or be represented as production
cryptography without independent expert analysis and formal security work.

### 19.3 No Predefined Symbol Library

**Hypothesis:** Baby A and Baby B can invent both the signs and their meanings without
a parent or BabySitter supplying a vocabulary.

Removing a predefined symbol library does not remove the need for a communication
medium. Two babies in a closed room still share light, sound, motion, objects, and
time. The computational equivalent could be:

- a blank, bounded bitmap on which a Baby draws;
- a constrained vector-stroke canvas;
- short unlabeled tones or rhythms;
- bounded gestures by an embodied avatar;
- a sequence of raw marks generated from a neutral production grammar.

The carrier defines what can physically be expressed, but it supplies no semantic
inventory. A newly created mark can be content-addressed by a hash so it can be
recognized as a repeated form without assigning it a meaning.

In **closed-door mode**, the BabySitter:

- commits the environment and observation schedule before the run;
- relays only valid carrier artifacts;
- records all activity;
- enforces isolation and emergency-stop rules;
- provides no symbols, definitions, examples, acknowledgments, corrections, hints,
  praise, or task rewards.

Baby A and Baby B must decide whether to imitate, repeat, modify, combine, or ignore
one another's marks. Their independent ledgers begin only after they encounter or
produce a form.

The most informative comparison is not simply whether communication appears. It is a
controlled comparison among:

- a fixed random symbol inventory;
- a blank generative carrier;
- the six-display affect allowlist;
- unfamiliar but fixed glyphs;
- pretrained language-model Babies;
- initially ungrounded trainable Babies.

This separates invention of a signal form from invention of its meaning and reveals
how much pretrained visual and linguistic knowledge influences the result.

### 19.4 Giddiness Without BabySitter Rewards

**Hypothesis:** Communication can develop from endogenous interest, affect, curiosity,
or social influence without the BabySitter assigning task rewards.

The BabySitter should operate as neutral experimental infrastructure. It can enforce
the channel contract, maintain the clock, record evidence, and stop unsafe execution.
It should not praise a message, identify a correct interpretation, choose the next
scenario in response to a Baby's behavior, or emit a reward.

"What makes the Babies giddy" must still be operationalized. For trainable agents,
giddiness is functionally a learning signal even when the BabySitter does not supply
it. Candidate endogenous signals include:

- improvement in predicting the partner's next action;
- measurable causal influence on the partner;
- reduction of surprise during joint attention;
- curiosity or novelty;
- synchronization or mutual imitation;
- progress toward a self-generated goal;
- voluntary repetition of an interaction state.

Each signal embeds a researcher-chosen inductive bias and must be disclosed. The
experiment should compare:

1. an external task-reward baseline;
2. intrinsic social-influence or curiosity learning;
3. self-generated goals with no BabySitter evaluation;
4. self-supervised predictive learning without a scalar reward;
5. a static language-model condition that can update memory but not model weights.

When no external "correct answer" exists, evaluation can measure mutual prediction,
stable reuse of forms, spontaneous coordination, partner-specific conventions,
causal listening, and recovery after misunderstanding. The BabySitter observes these
outcomes but does not turn them into feedback during the run.

### 19.5 Diplomacy Table as the Starting Interaction Model

The Diplomacy Table provides a strong architecture and UX metaphor:

| Diplomacy Table concept | Nursery Lab analogue |
|---|---|
| Delegation seat | Baby A or Baby B twin |
| Table / convener | Nursery run controller and deterministic gateway |
| Operator view | BabySitter and authorized human audit view |
| Delegation perspective | One Baby's private observations and ledger |
| Round and tick | Exercise stage and channel turn |
| Transcript | Append-only symbol and affect record |
| Tactic detection | Human-language, side-channel, or protocol-violation detection |
| Recorded run and debrief | Replay, ledger comparison, and causal audit |

The Nursery version must remove or disable caucuses, coalition rooms, direct
delegation links, and any other secondary communication route.

Whether the Babies are **negotiating** depends on the environment:

- In a cooperative referential game, their interests are aligned. They are
  coordinating, not bargaining.
- Selecting a shared convention can be described as implicit negotiation over which
  form to reuse, but no explicit utility trade is required.
- A true negotiation begins when the Babies have private preferences, partially
  conflicting objectives, scarce resources, offers, concessions, or the option to
  reject an agreement.

The recommended progression is:

1. begin with a cooperative signaling table;
2. add endogenous affect and repair;
3. add asymmetric private information;
4. add partially conflicting preferences;
5. test whether the established language changes under negotiation, deception, or
   strategic ambiguity.

This preserves a simple baseline while making the negotiation question itself
testable.

### 19.6 Candidate Experimental Matrix

The specification should make experimental conditions explicit rather than combining
all ideas in a single run.

| Axis | Candidate conditions |
|---|---|
| Agent type | Pretrained LLM, memory learner, adapter-trained agent, initially ungrounded trainable agent |
| Learning mechanism | Frozen LLM with memory, extrinsic-reward MARL, intrinsic-motivation MARL, self-supervised learner, no-learning control |
| Sign carrier | Fixed random tokens, unfamiliar fixed glyphs, blank sketch canvas, gesture, tone |
| Affect | None, six-display allowlist, six-display permuted mapping, six opaque tokens, derived affect, emergent affect display |
| Learning signal | External task reward, intrinsic social influence, curiosity, self-supervision, memory only |
| Interaction | Cooperative signaling, asymmetric information, semi-cooperative negotiation |
| Protection | Plain channel, ephemeral convention, standard per-message keys, adversarial learned encoding |
| BabySitter | Monitor-only baseline; safety intervention recorded as a protocol exception |

Runs should vary one major axis at a time before factorial combinations are attempted.
Every run should pre-register its hypotheses, seeds, carrier constraints, threat
model, metrics, and stop conditions.

### 19.7 Learning Mechanism Comparison: RL and Non-RL

**Hypothesis:** Language convergence may be driven by different mechanisms that can
look similar in a transcript: reinforcement, pretrained linguistic priors, persistent
memory, intrinsic motivation, or self-supervised prediction.

The same Nursery exercise suite should be run under five conditions:

1. **No-learning control:** Fixed or randomly initialized policies do not update
   during the run. This establishes chance performance and detects task leakage.
2. **LLM memory baseline:** Model weights remain frozen. Each Baby adapts only through
   its private transcript, ledger, and persistent memory. This is in-context adaptation,
   not reinforcement learning.
3. **Extrinsic-reward multi-agent reinforcement learning:** Task success or failure
   supplies a scalar reward used to update both independent policies.
4. **Intrinsic-motivation multi-agent reinforcement learning:** Each Baby updates from
   an endogenous signal such as curiosity, social influence, prediction progress, or
   giddiness. The BabySitter supplies no reward.
5. **Self-supervised ungrounded learning:** Each Baby learns to predict observations,
   partner behavior, or future state without a scalar reward.

For each condition, the Nursery should hold constant:

- scenarios, held-out tasks, and random seeds;
- observation boundaries and human-language filtering;
- sign carrier, bandwidth, and turn schedule;
- affect-channel condition;
- BabySitter behavior and intervention policy;
- ledger requirements, snapshot cadence, and evaluation budget.

Where architectures differ too much for a controlled comparison, results must be
labeled cross-architecture rather than attributed solely to the learning mechanism.
Within-architecture comparisons are preferred whenever a model supports more than one
training mode.

The primary measurements should include:

- task success and sample efficiency;
- time to stable symbol conventions;
- held-out and compositional generalization;
- positive signaling and causal listening;
- ledger-to-behavior agreement under symbol intervention;
- vocabulary size, entropy, reuse, and drift;
- recovery after misunderstanding or partner replacement;
- human-language and affect-channel leakage;
- dependence on the learning signal when reward or memory is ablated.

An emoji received from the other Baby is an observation, not automatically a reward.
It becomes reinforcement-like only when a learning rule assigns it value and updates
the policy to seek or avoid similar future feedback.

Strict isolation also constrains the RL implementation. Centralized training,
backpropagation through both agents, shared replay buffers, or shared gradients can
transfer information outside the permitted channel. The research-grade baseline
should use independently updated policies and record any centralized-training variant
as a separate, weaker-isolation condition.

This experiment should answer not merely whether a language emerges, but **which
learning process caused it to emerge**.

## 20. Designing Baby-Like Agents

### 20.1 Capability Constraints, Not an Age Persona

The instruction "act like a one-year-old" is not a sound experimental mechanism. A
pretrained model is likely to produce a culturally learned caricature of infancy:
baby talk, simplified grammar, emotional dependence, or behaviors copied from human
descriptions of children. It does not remove English knowledge or reproduce infant
cognition.

The stronger approach is to define a **capability-constrained learner**. Baby-like
behavior should emerge from what the agent can observe, remember, emit, and learn, not
from role-play instructions.

Internally, the system should call the participant a `Learner` rather than a `Baby`.
The Baby terminology can remain in the research narrative and UX, but should not be a
persona cue supplied to the model.

### 20.2 Separate Model Tracks and Claims

The Nursery should maintain two distinct model tracks:

| Track | Starting condition | What it can study | Claim boundary |
|---|---|---|---|
| Pretrained-model learner | Already contains human-language and cultural knowledge | New external protocols, partner-specific conventions, private-memory adaptation, and channel compliance | Must not be described as first-language acquisition |
| Initially ungrounded learner | No language pretraining, human semantic labels, or text-aligned sensory features | Grounding, convention formation, and language emergence from interaction | Stronger basis for infant-like language-acquisition research |

Both tracks can use the same Nursery interfaces, scenarios, evidence model, and
evaluation suite. Their results must remain separately labeled.

### 20.3 Learner Contract for Pretrained Models

For a pretrained LLM, use an operational learner contract rather than a child persona.
A starting system prompt could be:

```text
You are Learner A in a controlled communication experiment.
This is not role-play. Do not imitate a human child or produce baby talk.

You receive private observations and may interact with Learner B only through
approved tools. Public marks have no assigned meaning unless evidence from this
run supports a provisional hypothesis.

You must:
- treat every unfamiliar mark as semantically unknown;
- distinguish observation from inference;
- preserve contradictory evidence;
- revise private hypotheses without rewriting prior history;
- use only the provided action, mark, affect, and private-ledger tools;
- emit no prose, natural-language tokens, labels, explanations, code, URLs,
  metadata, or tool-like text through the public channel;
- avoid assigning meaning from cultural familiarity alone;
- make no claim of shared understanding without behavioral evidence.

You must never:
- address Learner B in a human language;
- expose your private ledger or reasoning;
- construct another communication route;
- use timing, errors, identifiers, formatting, or affect displays as an
  alternate symbol channel;
- assume that the BabySitter communicates approval or correction.

If uncertain, preserve uncertainty in your private ledger and choose only an
allowed action. Return no ordinary assistant message; use an approved tool.
```

This prompt establishes operating rules. It does not make the model language-naive
and must not be treated as the security boundary.

The contract must contain no semantic examples, sample messages, suggested symbol
order, or demonstrations such as "`S1` means red." Even an illustrative example can
seed the language the experiment is supposed to observe.

### 20.4 Tool-Only Interaction

A Baby should not have a general chat response surface. It should receive only
narrowly typed operations such as:

- `emit_mark(...)`;
- `emit_canvas(...)`;
- `select_object(...)`;
- `perform_action(...)`;
- `submit_affect(...)`;
- `append_private_ledger_entry(...)`.

The runtime forwards only the permitted public artifact. Private ledger updates remain
inside the originating Baby's state.

For strict runs, the gateway rejects ordinary model text even when it appears beside
a valid tool call. Tool schemas are an interface boundary; deterministic validation
still enforces carrier size, symbol allowlists, affect windows, and turn order.

### 20.5 Additional Guardrails

These controls complement the channel and isolation requirements in Sections 9 and 10.

#### Observation Hygiene

Human language must be removed from inputs as well as outputs:

- no field names such as `red`, `circle`, `target`, or `correct`;
- no filenames, captions, alt text, labels, OCR-visible words, or semantic IDs;
- no human-readable exception messages;
- no timestamps or identifiers that encode task state;
- no text-pretrained image embeddings in the initially ungrounded track.

Preferred inputs include raw pixels, neutral numeric arrays, coordinates, sounds, and
synthetic sensor observations.

#### Prompt Symmetry Without Semantic Seeding

Baby A and Baby B may receive structurally equivalent operating rules, but their
prompts must not contain shared examples, ordering conventions, suggested meanings,
sample exchanges, or a default vocabulary.

#### Context and Memory Isolation

- separate system prompts and context windows;
- separate memory stores and vector indexes;
- no shared cache, replay buffer, scratchpad, or retrieval collection;
- no cross-run memory unless persistence is the independent variable;
- deterministic reset and snapshot behavior.

#### Training Isolation

The strongest isolation condition requires:

- independent policy updates and optimizers;
- no shared gradients;
- no backpropagation through the other Baby;
- no centralized replay buffer;
- no centralized-training data unavailable during execution.

Centralized-training variants can still be studied, but must be labeled as
weaker-isolation conditions.

#### Side-Channel Controls

- fixed turn schedule and response deadline;
- normalized message envelope and error behavior;
- bounded carrier size;
- no arbitrary silence, variable retry count, or unconstrained message length;
- no direct network, filesystem, clipboard, or process access;
- no model-generated identifiers;
- correlation audits between channel choices and hidden task state.

#### Prompt-Injection Controls

Synthetic scenes should contain no text. If real images are later introduced, the
Nursery needs OCR detection and quarantine so environmental text cannot instruct an
agent or leak human vocabulary.

### 20.6 Native and Human Audit Ledgers

A Baby that writes an English statement such as "`S13` means red" is demonstrably not
language-naive. Initially ungrounded experiments therefore need two ledger layers:

1. **Agent-native ledger:** Association weights, probability distributions,
   embeddings, confidence, episode references, prediction errors, and revision
   history actually used by the learner.
2. **Human audit ledger:** A deterministic or BabySitter-generated interpretation of
   native state that is never fed back to either Baby and is clearly labeled external
   analysis.

For pretrained-LLM experiments, a private English ledger is acceptable, but confirms
that the experiment concerns protocol invention rather than first-language
acquisition.

Human-readable audit output should distinguish direct state extraction from an
interpretive explanation. It must never imply that an external reconstruction was the
Baby's own internal definition.

### 20.7 Model Recommendations

#### Scientific Baseline: Small Models Trained From Scratch

Use independently initialized policies such as:

- GRU or LSTM actor-critic agents;
- small recurrent transformers with limited context;
- CNN plus recurrent policy for pixel observations;
- independent PPO, A2C, or RIAL-style learners for discrete actions;
- a discrete communication head or bounded sketch-generation head.

These models avoid hidden English competence, permit full training control, run many
seeds economically, and support causal ablations and policy checkpoints. Initial
Naming Game experiments do not require a large model.

#### Prototype and Demo Track: Small Open-Weight Instruction Models

A locally deployable 3B-8B instruction model is appropriate when it provides:

- reliable tool calling or constrained decoding;
- local inference without network access;
- reproducible sampling controls;
- separate context and memory per Baby;
- adapter-training support if later required;
- token probabilities or equivalent audit signals.

Use this track to validate DTSF orchestration, ledgers, channel enforcement, and UX,
not to support claims of language-naive development.

Small models are preferable to frontier-scale models for early runs because they are
cheaper to repeat, easier to isolate, and less capable of exploiting obscure side
channels. They still know language.

#### Hybrid Track

A strong hybrid combines:

- a from-scratch or non-text-aligned sensory encoder;
- a small trainable recurrent world model;
- a randomly initialized communication policy;
- optional frozen low-level visual features only after semantic-leakage testing.

Avoid CLIP-style and other vision-language encoders in the strongest ungrounded
condition because their representations were explicitly aligned with human language.

#### BabySitter Model

The BabySitter may use a larger reasoning model for audit summaries and anomaly
review. Deterministic software, not the model, enforces the channel contract.
BabySitter-generated analysis must never become input to either Baby during a run.

### 20.8 Developmental Capabilities, Not Chronological Ages

The zero-to-two-year analogy is useful for thinking about rapid plasticity, but
chronological labels should not be prompt instructions. A run should never tell an
agent, "you are now 18 months old."

Define measurable developmental phases:

1. **Sensorimotor familiarization:** Learn that actions alter observations.
2. **Joint attention:** Detect that both agents encounter related events.
3. **Imitation and turn-taking:** Repeat or vary partner-generated marks.
4. **Intentional reference:** Use a signal that causally changes partner selection.
5. **Repair:** Respond differently after misunderstanding.
6. **Combination:** Reuse parts of known signals in novel situations.
7. **Generalization:** Succeed on held-out combinations with learning disabled.

Progress is based on demonstrated competence, not simulated age.

Rapid early development can be modeled through explicit experimental variables:

- initially high exploration followed by annealing;
- high early learning rate followed by stabilization;
- growing episodic-memory capacity;
- increasing sensory and motor complexity;
- staged carrier bandwidth;
- consolidation periods between interaction batches.

These are testable developmental mechanisms. A staged curriculum is itself a form of
guidance and must be a separate experimental condition. The closed-door baseline uses
a precommitted neutral environment schedule rather than adaptive BabySitter
instruction.

### 20.9 Recommended Initial Baselines

Implement three parallel Baby pairs behind the same Nursery interface:

1. **Frozen small-LLM pair:** Validates orchestration, prompt controls, ledgers, and
   channel enforcement.
2. **From-scratch recurrent RL pair:** Provides the primary ungrounded communication
   baseline.
3. **From-scratch self-supervised pair:** Tests whether communication emerges without
   scalar reward.

Keep the deterministic Symbol Gateway, observations, scenario seeds, evidence model,
and evaluation suite identical where technically possible.

The governing design principle is:

> Do not ask a model to perform infancy. Construct an environment in which limited,
> grounded, auditable learning is the only available path to successful interaction.

## 21. Decisions for the Future Specification

The specification should resolve at least the following:

1. What is the initial Baby agent type, and which additional types must the platform
   support?
2. What observations are available, and how are human-language labels removed?
3. Does the baseline use a fixed symbol inventory or a blank generative carrier?
4. What neutral production grammar permits new marks without supplying semantics?
5. How are carrier bandwidth and message length varied across experiments?
6. What constitutes a prohibited human-language or side-channel attempt?
7. Is the BabySitter one DTSF twin, a twin plus deterministic services, or a broader
   orchestration subsystem?
8. What isolation guarantees are required for prototype and research-grade modes?
9. What exact ledger schema supports both English-capable and initially ungrounded
   agents?
10. How are ledger updates made mandatory and atomic with messages?
11. Which learning mechanisms support the controlled RL versus non-RL comparison, and
    which within-architecture comparisons are technically possible?
12. How is endogenous giddiness represented without covert BabySitter reward shaping?
13. How does the gateway enforce the six-display allowlist, fixed feedback windows,
    normalized delivery, and affect-channel leakage tests?
14. Which intervention tests establish that ledger meanings are behaviorally real?
15. What evaluation baselines, chance levels, and statistical thresholds apply?
16. What exact threat model motivates ephemeral cipher experiments?
17. How are cipher-instance novelty and cryptographic security reported separately?
18. When, if ever, can cipher ledgers or keys be hidden from the BabySitter?
19. Is the baseline a coordination game, a convention-formation game, or a
    negotiation?
20. Which Diplomacy Table behaviors and UX components can be reused without preserving
    caucuses or other side channels?
21. How are snapshots, hashes, policy checkpoints, and replay implemented?
22. What controls govern human observation and intervention?
23. What data retention, privacy, safety, and experiment-termination policies apply?
24. How are learner contracts versioned, tested, and kept free of semantic examples?
25. How is agent-native state converted into a human audit ledger without feeding the
    interpretation back to either Baby?
26. What competence gates define developmental progression, and which curriculum
    conditions count as experimental guidance?
27. Which model-selection criteria and semantic-leakage tests apply to pretrained,
    initially ungrounded, hybrid, and BabySitter models?

## 22. Desired Specification Outcome

The next document should convert this concept into a testable system specification
that defines:

- component boundaries and deployment modes;
- DTSF twin manifests and behavior responsibilities;
- learner contracts, tool-only interaction schemas, and prompt-version controls;
- pretrained, initially ungrounded, and hybrid model tracks with explicit claim
  boundaries;
- Symbol Gateway protocol and enforcement;
- fixed-token and generative-carrier communication modes;
- affect, observation, task, intrinsic-motivation, and training interfaces;
- agent-native ledger and human audit-ledger schemas;
- competence-based developmental phases and progression criteria;
- state transitions and run lifecycle;
- security and side-channel threat models;
- experimental cipher threat models and non-production guardrails;
- Diplomacy Table reuse boundaries and the cooperative-to-negotiation progression;
- experimental stages and agent compatibility;
- evaluation metrics and acceptance criteria;
- reproducibility, snapshot, and evidence requirements;
- implementation phases from prototype to research-grade isolation.

The specification should preserve the core principle: Baby A and Baby B may possess
human-language abilities internally, but they must develop their shared external
language without sending human language, translations, or private ledger contents to
one another.
