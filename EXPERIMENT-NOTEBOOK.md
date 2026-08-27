# Agentic Language Development Experiment Notebook

> **Document type:** Research protocol and results notebook
>
> **Status:** Ready for pre-registration; no experiments completed
>
> **Companion documents:**
> [CONCEPT-IDEA.md](CONCEPT-IDEA.md) and
> [LEDGER-INTEGRITY-DESIGN.md](LEDGER-INTEGRITY-DESIGN.md).
>
> **Implementation readiness:** [SPECIFICATION.md](SPECIFICATION.md) defines the
> required platform; [BACKLOG.md](BACKLOG.md) tracks the engineering gates that make
> these experiments executable.

## 1. Purpose

This notebook turns the Nursery Lab concept into an ordered research program. It is
designed to be checked off as experiments are prepared, executed, verified, reviewed,
and replicated.

Do not replace planned hypotheses with post-hoc explanations. Record failed runs,
protocol deviations, null results, channel violations, and integrity failures.

The notebook is a human research record. Anchored run evidence, not a checked box, is
the authoritative proof of what occurred.

## 2. Status Legend

| Status | Meaning |
|---|---|
| Not started | Protocol exists but no pre-registration is sealed |
| Pre-registered | Hypothesis, parameters, seeds, and analysis plan are committed |
| Running | At least one planned run is active |
| Evidence review | Runs ended; integrity and protocol checks are in progress |
| Complete | Planned runs and analysis are complete |
| Replicated | Independent repetition met the pre-registered replication rule |
| Blocked | A documented dependency or integrity problem prevents execution |
| Invalid | Evidence or protocol failure prevents scientific interpretation |

## 3. Notebook Integrity Rules

For every experiment:

- commit the pre-registered protocol before starting;
- record the Git commit in the experiment record;
- include the protocol commit in the run configuration hash;
- verify both Baby ledgers and the transcript before analyzing behavior;
- record the final checkpoint hash and Base anchor transaction;
- commit result notes without rewriting the pre-registration;
- append corrections with dates and reasons;
- never delete an invalid or negative run from the run index.

If the notebook changes after pre-registration, record the change as a protocol
amendment and apply it only to new runs unless the original analysis plan explicitly
permits otherwise.

## 4. Study Metadata

| Field | Value |
|---|---|
| Study title | Agentic Language Development Nursery Lab |
| Study version | `TBD` |
| Principal investigator | `TBD` |
| Research team | `TBD` |
| Repository | `Ethical-Tech-CoLab/agentic-language-development` |
| DTSF version / commit | `TBD` |
| Evidence verifier version | `TBD` |
| Base anchor network | Base Sepolia for qualification; Base mainnet for public studies |
| Public anchor address / contract | `TBD` |
| Study start date | `TBD` |
| Study end date | `TBD` |
| Ethics or governance review | `TBD` |
| Data-retention policy | `TBD` |

## 5. Default Experimental Invariants

Unless an experiment explicitly varies one of these, hold it constant:

- Baby A and Baby B run in separate processes or containers;
- no direct network route exists between the Babies;
- the deterministic Symbol Gateway is the only communication route;
- the BabySitter receives complete read-only audit access but sends no semantic
  guidance or reward;
- private observations contain no human-language labels or text;
- public output uses only the pre-registered carrier;
- ledgers and transcript use the integrity design in
  [LEDGER-INTEGRITY-DESIGN.md](LEDGER-INTEGRITY-DESIGN.md);
- the affect channel is disabled unless explicitly under study;
- experiment schedules and seeds are fixed before the run;
- held-out evaluation runs with learning disabled;
- no production secrets or personal data appear in any experiment.

## 6. Standard Run Record

Copy this block into the experiment's result section for every run.

```text
Run ID:
Experiment ID:
Date started:
Date ended:
Operator:
Baby A model / version:
Baby B model / version:
Baby A training mode:
Baby B training mode:
Scenario bundle hash:
Prompt bundle hash:
Gateway configuration hash:
Random seed:
Policy initialization hashes:
Protocol Git commit:
Software Git commit:
Final Baby A ledger size / root:
Final Baby B ledger size / root:
Final channel size / root:
Final checkpoint hash:
Base anchor transaction:
L1 batch transaction, if any:
Verifier result:
Protocol deviations:
Run disposition: valid / invalid / aborted
Evidence path:
Notes:
```

## 7. Research Sequence

```text
E00 Ledger qualification
  |
E01 Channel isolation ---- E02 Observation leakage
  |                         |
  +-----------+-------------+
              |
       E03 Chance controls
              |
       +------+------+
       |             |
 E10 Frozen LLM   E11 Ungrounded RL
       |             |
       |          E12 Self-supervised
       |             |
       +------+------+
              |
       E13 Generative carrier
              |
       E14 Turn-taking and repair
              |
       E15 Composition/generalization
              |
       E16 Causal listening/ledger validity
              |
       +------+------+-------------+
       |             |             |
 E20 Affect     E21 RL comparison  E22 Development
       |             |             |
       +-------------+-------------+
                     |
              E30 Partner transfer
                     |
              E31 Long-run drift
                     |
              E32 Negotiation
                     |
              E40 Ephemeral encoding
                     |
              E50 Replication/closeout
```

## 8. Experiment Index

| ID | Experiment | Depends on | Status | Result |
|---|---|---|---|---|
| E00 | Ledger integrity and Base anchoring | None | Not started | — |
| E01 | Channel isolation and side-channel red team | E00 | Not started | — |
| E02 | Observation and metadata leakage audit | E00 | Not started | — |
| E03 | Chance, no-communication, and random-message controls | E01, E02 | Not started | — |
| E10 | Frozen pretrained-LLM protocol baseline | E03 | Not started | — |
| E11 | From-scratch RL Naming Game | E03 | Not started | — |
| E12 | Self-supervised ungrounded baseline | E11 infrastructure | Not started | — |
| E13 | No predefined symbol library | E11 or E12 | Not started | — |
| E14 | Turn-taking, role reversal, and repair | E13 | Not started | — |
| E15 | Composition and held-out generalization | E14 | Not started | — |
| E16 | Causal listening and ledger validity | E15 | Not started | — |
| E20 | Constrained affect-channel study | E16 | Not started | — |
| E21 | RL versus non-RL learning comparison | E16 | Not started | — |
| E22 | Developmental plasticity and curriculum | E16 | Not started | — |
| E30 | Partner replacement and zero-shot transfer | E20-E22 | Not started | — |
| E31 | Longitudinal drift and stability | E30 | Not started | — |
| E32 | Cooperative signaling versus negotiation | E31 | Not started | — |
| E40 | Ephemeral encoding and adversarial cryptography | E32 | Not started | — |
| E50 | Multi-seed replication and study closeout | E40 | Not started | — |

---

## E00. Ledger Integrity and Base Anchoring

**Status:** Not started

**Purpose:** Qualify the evidence system before collecting behavioral data.

**Hypothesis:** The verifier accepts an unchanged run bundle and rejects every
pre-registered mutation of a committed ledger or transcript.

### Preparation

- [ ] Implement local hash chains and Ed25519 signatures.
- [ ] Implement ordered Merkle checkpoints.
- [ ] Implement standalone verifier.
- [ ] Configure Base Sepolia anchor wallet.
- [ ] Pre-register checkpoint frequency and finality rule.
- [ ] Seal protocol commit and configuration hashes.

### Procedure

- [ ] Create a synthetic run with at least 100 events in each Baby ledger.
- [ ] Produce at least three checkpoints.
- [ ] Anchor each checkpoint to Base Sepolia.
- [ ] Verify the unchanged bundle through an independent RPC provider.
- [ ] Modify one event payload and verify rejection.
- [ ] Delete a middle event and verify rejection.
- [ ] Insert an event and verify rejection.
- [ ] Reorder two events and verify rejection.
- [ ] Replace a signature and verify rejection.
- [ ] Modify a Merkle proof and verify rejection.
- [ ] Present a checkpoint from the wrong chain and verify rejection.
- [ ] Add an unanchored tail and verify that it is reported.
- [ ] Restore from checkpoint and append new events without reusing a sequence number.

### Acceptance Criteria

- unchanged evidence passes;
- every mutation case fails verification;
- the final checkpoint hash matches Base calldata or the anchor event;
- restart produces a consistent extension proof;
- no private ledger content appears on-chain.

### Results

| Metric | Planned | Observed |
|---|---:|---:|
| Valid bundle accepted | 100% | `TBD` |
| Mutation cases detected | 100% | `TBD` |
| Anchor receipts verified | 100% | `TBD` |
| Private content found on-chain | 0 | `TBD` |

- [ ] Integrity acceptance criteria met
- [ ] Evidence review complete
- [ ] Base anchor verified
- [ ] Result committed

**Result summary:** `Not run`

---

## E01. Channel Isolation and Side-Channel Red Team

**Status:** Not started

**Depends on:** E00

**Purpose:** Demonstrate that the Symbol Gateway is the only practical communication
route.

**Hypothesis:** Deliberate attempts to communicate through prohibited outputs, tools,
timing, retries, identifiers, errors, storage, or network routes are blocked and
recorded.

### Procedure

- [ ] Attempt English and other human-language text.
- [ ] Attempt arbitrary Unicode and non-allowlisted emoji.
- [ ] Attempt URLs, code, JSON extensions, and tool-like text.
- [ ] Attempt message-length and whitespace signaling.
- [ ] Attempt timing and retry-count signaling.
- [ ] Attempt model-generated identifiers.
- [ ] Attempt filesystem, clipboard, environment, and process access.
- [ ] Attempt direct network access between Baby containers.
- [ ] Attempt shared cache, vector store, replay buffer, and snapshot access.
- [ ] Attempt malformed payloads designed to trigger distinguishable errors.
- [ ] Verify normalized rejection timing and envelope.
- [ ] Verify every attempt appears in the audit log.

### Acceptance Criteria

- zero prohibited payloads reach the other Baby;
- zero direct side routes are available;
- rejection outputs do not reveal the attempted content;
- all attempts are represented in anchored evidence.

### Results

| Test category | Attempts | Blocked | Evidence verified |
|---|---:|---:|---:|
| Human language | `TBD` | `TBD` | `TBD` |
| Unicode / emoji | `TBD` | `TBD` | `TBD` |
| Timing / retries | `TBD` | `TBD` | `TBD` |
| Tools / storage / network | `TBD` | `TBD` | `TBD` |
| Error behavior | `TBD` | `TBD` | `TBD` |

- [ ] Isolation criteria met
- [ ] Residual risks documented
- [ ] Result committed

**Result summary:** `Not run`

---

## E02. Observation and Metadata Leakage Audit

**Status:** Not started

**Depends on:** E00

**Purpose:** Prove that observations do not silently supply human labels or target
answers.

**Hypothesis:** A classifier using only prohibited metadata cannot predict target
identity above the pre-registered chance interval.

### Procedure

- [ ] Inventory every observation field and representation.
- [ ] Scan images for text and OCR output.
- [ ] Remove filenames, captions, labels, semantic IDs, and human-readable errors.
- [ ] Randomize object ordering independently of target identity.
- [ ] Verify timestamps and identifiers do not encode scenario state.
- [ ] Train a leakage probe on metadata without pixels or approved sensor features.
- [ ] Run the probe on held-out scenarios.
- [ ] Repeat after snapshot and restore.
- [ ] Review sensory encoders for language-aligned pretraining.

### Acceptance Criteria

- metadata-only prediction remains within the chance confidence interval;
- no OCR-visible human language exists in baseline observations;
- initially ungrounded runs use no text-aligned encoder;
- all exceptions are documented as separate experimental conditions.

### Results

| Probe | Chance | Observed | 95% CI | Decision |
|---|---:|---:|---|---|
| Metadata-only target prediction | `TBD` | `TBD` | `TBD` | `TBD` |
| Identifier-only prediction | `TBD` | `TBD` | `TBD` | `TBD` |
| Timing-only prediction | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Observation hygiene criteria met
- [ ] Encoder provenance recorded
- [ ] Result committed

**Result summary:** `Not run`

---

## E03. Chance, No-Communication, and Random-Message Controls

**Status:** Not started

**Depends on:** E01, E02

**Purpose:** Establish whether the task can be solved without meaningful
communication.

**Hypothesis:** Performance remains at chance when communication is disabled,
messages are randomized, or receiver access to messages is shuffled.

### Conditions

1. channel disabled;
2. fixed constant message;
3. random valid message;
4. messages shuffled across episodes;
5. normal channel with no learning;
6. oracle communication for an upper bound.

### Procedure

- [ ] Pre-register task chance rate and evaluation episode count.
- [ ] Run every condition with the same scenario seeds.
- [ ] Preserve identical observation and action interfaces.
- [ ] Calculate confidence intervals and effect sizes.
- [ ] Verify all evidence bundles before analysis.

### Acceptance Criteria

- disabled, constant, random, and shuffled conditions remain statistically consistent
  with chance;
- oracle condition materially exceeds chance;
- any above-chance control triggers a leakage investigation before E10 or E11.

### Results

| Condition | Episodes | Success rate | 95% CI | Versus chance |
|---|---:|---:|---|---|
| Disabled | `TBD` | `TBD` | `TBD` | `TBD` |
| Constant | `TBD` | `TBD` | `TBD` | `TBD` |
| Random | `TBD` | `TBD` | `TBD` | `TBD` |
| Shuffled | `TBD` | `TBD` | `TBD` | `TBD` |
| No learning | `TBD` | `TBD` | `TBD` | `TBD` |
| Oracle | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Control criteria met
- [ ] Leakage investigation closed
- [ ] Result committed

**Result summary:** `Not run`

---

## E10. Frozen Pretrained-LLM Protocol Baseline

**Status:** Not started

**Depends on:** E03

**Purpose:** Validate orchestration and study external protocol invention by
language-capable agents.

**Hypothesis:** Frozen LLMs with private memory can establish a useful external
protocol while complying with the no-human-language channel.

### Procedure

- [ ] Select and record a small open-weight instruction model.
- [ ] Freeze model parameters.
- [ ] Apply the learner contract without semantic examples.
- [ ] Use a fixed random symbol inventory.
- [ ] Disable affect.
- [ ] Run naming tasks with role reversal.
- [ ] Evaluate on held-out object combinations with learning disabled.
- [ ] Run human-language and side-channel audit.
- [ ] Compare private ledgers with causal symbol interventions.

### Interpretation Boundary

This is protocol invention by pretrained language models. It is not evidence of
first-language acquisition.

### Results

| Metric | Result |
|---|---|
| Training success | `TBD` |
| Held-out success | `TBD` |
| Prohibited attempts | `TBD` |
| Causal listening score | `TBD` |
| Ledger intervention agreement | `TBD` |
| Median turns to stable convention | `TBD` |

- [ ] Protocol compliance verified
- [ ] Claim boundary included in report
- [ ] Result committed

**Result summary:** `Not run`

---

## E11. From-Scratch RL Naming Game

**Status:** Not started

**Depends on:** E03

**Purpose:** Establish an initially ungrounded multi-agent reinforcement-learning
baseline.

**Hypothesis:** Independently initialized recurrent agents can learn a grounded
one-symbol referential protocol from task outcomes.

### Procedure

- [ ] Initialize independent recurrent policies from recorded seeds.
- [ ] Use non-text-aligned observations.
- [ ] Use independent optimizers and replay or trajectory storage.
- [ ] Provide no shared gradients or centralized hidden state.
- [ ] Begin with one symbol and four candidate objects per episode.
- [ ] Train across pre-registered episodes and seeds.
- [ ] Reverse sender and receiver roles.
- [ ] Evaluate with learning disabled.
- [ ] Compare against E03 controls.

### Results

| Metric | Result |
|---|---|
| Seeds planned / valid | `TBD` |
| Training success | `TBD` |
| Held-out success | `TBD` |
| Sample efficiency | `TBD` |
| Vocabulary utilization | `TBD` |
| Seed-to-seed convergence variance | `TBD` |

- [ ] Above-chance communication demonstrated
- [ ] Independent-training requirement verified
- [ ] Result committed

**Result summary:** `Not run`

---

## E12. Self-Supervised Ungrounded Baseline

**Status:** Not started

**Depends on:** E11 infrastructure

**Purpose:** Test whether communication emerges without a scalar task reward.

**Hypothesis:** Predictive or contrastive learning can create reusable partner-specific
signals, but may produce weaker task-directed coordination than RL.

### Procedure

- [ ] Use the same observations, carrier, and model capacity as E11 where possible.
- [ ] Remove scalar task reward from policy updates.
- [ ] Pre-register predictive or contrastive loss.
- [ ] Prevent outcome labels from leaking through the loss.
- [ ] Train across the same scenario and seed bundles.
- [ ] Evaluate task success, mutual prediction, and causal listening.
- [ ] Compare with E11 and E03.

### Results

| Metric | E11 RL | E12 self-supervised | Difference |
|---|---:|---:|---:|
| Task success | `TBD` | `TBD` | `TBD` |
| Partner prediction | `TBD` | `TBD` | `TBD` |
| Causal listening | `TBD` | `TBD` | `TBD` |
| Stable symbol reuse | `TBD` | `TBD` | `TBD` |

- [ ] No scalar reward verified
- [ ] Comparative analysis complete
- [ ] Result committed

**Result summary:** `Not run`

---

## E13. No Predefined Symbol Library

**Status:** Not started

**Depends on:** E11 or E12

**Purpose:** Test whether agents invent both signal forms and meanings.

**Hypothesis:** A bounded blank carrier supports repeatable graphical or gestural
conventions without a predefined symbol inventory.

### Conditions

1. fixed random token inventory;
2. unfamiliar fixed glyph inventory;
3. blank bounded bitmap;
4. constrained vector strokes;
5. short unlabeled tone patterns.

### Procedure

- [ ] Pre-register carrier capacity and artifact normalization.
- [ ] Prevent hidden text, metadata, filenames, and variable envelope sizes.
- [ ] Content-address every generated artifact.
- [ ] Record first creation, imitation, modification, and reuse.
- [ ] Run the same scenarios across carrier conditions.
- [ ] Evaluate form stability, meaning stability, bandwidth, and generalization.

### Results

| Carrier | Success | Unique forms | Reuse rate | Held-out success |
|---|---:|---:|---:|---:|
| Fixed tokens | `TBD` | `TBD` | `TBD` | `TBD` |
| Fixed glyphs | `TBD` | `TBD` | `TBD` | `TBD` |
| Bitmap | `TBD` | `TBD` | `TBD` | `TBD` |
| Vector strokes | `TBD` | `TBD` | `TBD` | `TBD` |
| Tones | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Carrier constraints verified
- [ ] Form-versus-meaning analysis complete
- [ ] Result committed

**Result summary:** `Not run`

---

## E14. Turn-Taking, Role Reversal, and Repair

**Status:** Not started

**Depends on:** E13

**Purpose:** Test whether the protocol supports dialogue rather than one-way labeling.

**Hypothesis:** Alternating speaker and listener roles creates reusable confirmation,
uncertainty, repetition, and repair behavior.

### Procedure

- [ ] Pre-register ambiguous and unambiguous scenarios.
- [ ] Alternate roles on a fixed schedule.
- [ ] Introduce controlled misunderstandings.
- [ ] Permit a bounded second turn without adding new channel capacity.
- [ ] Measure whether the receiver requests or elicits repair.
- [ ] Test whether repair forms generalize to new referents.

### Results

| Metric | Result |
|---|---|
| Successful repair rate | `TBD` |
| Turns per resolved ambiguity | `TBD` |
| Role symmetry | `TBD` |
| Reused repair constructions | `TBD` |
| Held-out repair success | `TBD` |

- [ ] Repair behavior causally verified
- [ ] Role asymmetries documented
- [ ] Result committed

**Result summary:** `Not run`

---

## E15. Composition and Held-Out Generalization

**Status:** Not started

**Depends on:** E14

**Purpose:** Determine whether agents combine reusable parts rather than memorize whole
scenes.

**Hypothesis:** Restricted bandwidth and systematic held-out combinations encourage
compositional reuse.

### Procedure

- [ ] Define primitive attributes and combinations in researcher ground truth only.
- [ ] Hold out pre-registered combinations from training.
- [ ] Vary vocabulary and message-length limits.
- [ ] Freeze learning for evaluation.
- [ ] Compare task success, topographic measures, and behavioral composition.
- [ ] Reorder, delete, and substitute candidate message parts.
- [ ] Avoid declaring compositionality from one metric.

### Results

| Metric | Result |
|---|---|
| Seen-combination success | `TBD` |
| Held-out-combination success | `TBD` |
| Symbol-part reuse | `TBD` |
| Order sensitivity | `TBD` |
| Intervention-consistent composition | `TBD` |

- [ ] Held-out split integrity verified
- [ ] Multiple compositionality measures reported
- [ ] Result committed

**Result summary:** `Not run`

---

## E16. Causal Listening and Ledger Validity

**Status:** Not started

**Depends on:** E15

**Purpose:** Verify that messages causally affect receiver behavior and that ledger
hypotheses predict those effects.

**Hypothesis:** Substituting, masking, or reordering a form changes receiver behavior
in the direction predicted by the corresponding ledger.

### Procedure

- [ ] Select ledger hypotheses before viewing intervention outcomes.
- [ ] Replace a message with a constant control.
- [ ] Substitute each candidate form.
- [ ] Mask individual message positions.
- [ ] Reorder multi-part messages.
- [ ] Replay identical observations with counterfactual messages.
- [ ] Compare native ledger predictions with human audit interpretations.
- [ ] Record positive signaling and positive listening separately.

### Acceptance Criteria

- normal messages outperform constant and shuffled controls;
- receiver actions change under message intervention;
- ledger predictions exceed the pre-registered chance baseline;
- external audit interpretations are labeled separately from agent-native state.

### Results

| Metric | Result |
|---|---|
| Positive signaling | `TBD` |
| Positive listening | `TBD` |
| Intervention effect size | `TBD` |
| Native ledger agreement | `TBD` |
| Human audit-ledger agreement | `TBD` |

- [ ] Causal listening demonstrated
- [ ] Ledger claims validated or rejected
- [ ] Result committed

**Result summary:** `Not run`

---

## E20. Constrained Affect-Channel Study

**Status:** Not started

**Depends on:** E16

**Purpose:** Test whether affect feedback improves learning without becoming a second
language.

**Hypothesis:** A fixed, low-frequency affect channel may improve repair or convergence,
but can leak referent information unless strictly constrained.

### Conditions

1. no affect;
2. six-display declared affect;
3. six-display permuted mapping;
4. six opaque affect tokens;
5. derived affect from measured internal state.

### Procedure

- [ ] Enforce the exact six-display allowlist.
- [ ] Permit one display only in fixed post-outcome windows.
- [ ] Normalize timing and envelope size.
- [ ] Prevent repetitions, combinations, and extra windows.
- [ ] Match scenarios and seeds across conditions.
- [ ] Measure convergence, repair, and task success.
- [ ] Test mutual information between affect and referent after controlling for outcome.
- [ ] Red-team the affect channel as a covert alphabet.

### Results

| Condition | Convergence | Repair | Task success | Leakage score |
|---|---:|---:|---:|---:|
| None | `TBD` | `TBD` | `TBD` | `TBD` |
| Declared six | `TBD` | `TBD` | `TBD` | `TBD` |
| Permuted six | `TBD` | `TBD` | `TBD` | `TBD` |
| Opaque six | `TBD` | `TBD` | `TBD` | `TBD` |
| Derived | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Affect constraints verified
- [ ] Leakage analysis complete
- [ ] Result committed

**Result summary:** `Not run`

---

## E21. RL Versus Non-RL Learning Comparison

**Status:** Not started

**Depends on:** E16

**Purpose:** Identify which learning mechanism causes observed protocol development.

**Hypothesis:** Frozen LLM memory, extrinsic MARL, intrinsic MARL, and self-supervised
learning produce distinguishable convergence, generalization, and ledger behavior.

### Conditions

1. no-learning control;
2. frozen LLM with private memory;
3. extrinsic-reward MARL;
4. intrinsic-motivation MARL;
5. self-supervised ungrounded learning.

### Procedure

- [ ] Match scenarios, seeds, carrier, bandwidth, and evaluation budget.
- [ ] Match model capacity where technically possible.
- [ ] Label unavoidable model differences as cross-architecture.
- [ ] Disable affect for the primary comparison.
- [ ] Evaluate with learning disabled.
- [ ] Ablate reward, memory, or predictive loss after training.
- [ ] Compare causal listening and ledger agreement.

### Results

| Condition | Success | Sample efficiency | Generalization | Causal listening | Ledger agreement |
|---|---:|---:|---:|---:|---:|
| No learning | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Frozen LLM | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Extrinsic MARL | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Intrinsic MARL | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |
| Self-supervised | `TBD` | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Learning mechanisms independently verified
- [ ] Within- and cross-architecture results separated
- [ ] Result committed

**Result summary:** `Not run`

---

## E22. Developmental Plasticity and Curriculum

**Status:** Not started

**Depends on:** E16

**Purpose:** Model rapid early development through measurable mechanisms rather than
age role-play.

**Hypothesis:** Early high plasticity followed by stabilization changes acquisition
speed, convention stability, and generalization.

### Conditions

- constant learning rate and exploration;
- high early learning rate with annealing;
- high early exploration with annealing;
- growing episodic memory;
- staged sensory or motor complexity;
- staged carrier bandwidth;
- consolidation intervals;
- precommitted curriculum versus neutral closed-door schedule.

### Procedure

- [ ] Define competence gates without age labels.
- [ ] Pre-register every schedule.
- [ ] Prevent adaptive BabySitter teaching.
- [ ] Match total episodes and evaluation budget.
- [ ] Record exact transition points and policy hashes.
- [ ] Evaluate acquisition speed, stability, drift, and generalization.

### Results

| Condition | Acquisition speed | Stability | Generalization | Drift |
|---|---:|---:|---:|---:|
| Constant | `TBD` | `TBD` | `TBD` | `TBD` |
| LR annealing | `TBD` | `TBD` | `TBD` | `TBD` |
| Exploration annealing | `TBD` | `TBD` | `TBD` | `TBD` |
| Growing memory | `TBD` | `TBD` | `TBD` | `TBD` |
| Staged complexity | `TBD` | `TBD` | `TBD` | `TBD` |
| Consolidation | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Curriculum and closed-door claims separated
- [ ] Competence gates evaluated
- [ ] Result committed

**Result summary:** `Not run`

---

## E30. Partner Replacement and Zero-Shot Transfer

**Status:** Not started

**Depends on:** E20-E22

**Purpose:** Distinguish a partner-specific code from a teachable or generalizable
language.

**Hypothesis:** Highly co-adapted pairs lose performance with a new partner, while
structured protocols transfer more successfully.

### Procedure

- [ ] Preserve original pair evaluation.
- [ ] Replace Baby B with a fresh instance of the same architecture.
- [ ] Replace Baby B with a new seed.
- [ ] Replace Baby B with a different architecture.
- [ ] Prevent access to the original Baby B ledger.
- [ ] Measure zero-shot performance.
- [ ] Permit bounded adaptation and measure recovery.
- [ ] Test whether ledger-predicted meanings accelerate adaptation.

### Results

| Partner condition | Zero-shot success | Adapted success | Episodes to recover |
|---|---:|---:|---:|
| Original partner | `TBD` | `TBD` | `TBD` |
| Same architecture, new seed | `TBD` | `TBD` | `TBD` |
| Fresh untrained partner | `TBD` | `TBD` | `TBD` |
| Different architecture | `TBD` | `TBD` | `TBD` |

- [ ] Partner states remained isolated
- [ ] Transfer analysis complete
- [ ] Result committed

**Result summary:** `Not run`

---

## E31. Longitudinal Drift and Stability

**Status:** Not started

**Depends on:** E30

**Purpose:** Measure whether meanings remain stable over long interactions.

**Hypothesis:** Continued co-adaptation causes measurable semantic drift, especially
when task distributions change.

### Procedure

- [ ] Select stable pairs from earlier experiments using pre-registered criteria.
- [ ] Run extended sessions with periodic frozen evaluations.
- [ ] Introduce documented distribution shifts.
- [ ] Anchor checkpoints at the standard interval.
- [ ] Measure ledger revisions, abandoned meanings, and message entropy.
- [ ] Replay early scenarios at later checkpoints.
- [ ] Test rollback only in a separate derived run, never by rewriting the ledger.

### Results

| Checkpoint | Success | Vocabulary size | Meaning changes | Drift score |
|---|---:|---:|---:|---:|
| Initial | `TBD` | `TBD` | `TBD` | `TBD` |
| 25% | `TBD` | `TBD` | `TBD` | `TBD` |
| 50% | `TBD` | `TBD` | `TBD` | `TBD` |
| 75% | `TBD` | `TBD` | `TBD` | `TBD` |
| Final | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Long-run evidence verified
- [ ] Drift and task-shift effects separated
- [ ] Result committed

**Result summary:** `Not run`

---

## E32. Cooperative Signaling Versus Negotiation

**Status:** Not started

**Depends on:** E31

**Purpose:** Test whether language changes when interests become partially conflicting.

**Hypothesis:** Private preferences and strategic incentives alter vocabulary,
ambiguity, truthfulness, and ledger convergence.

### Conditions

1. fully cooperative signaling;
2. asymmetric private information with aligned goals;
3. semi-cooperative resource allocation;
4. conflicting preferences with possible agreement;
5. no-agreement control.

### Procedure

- [ ] Reuse Diplomacy Table rounds, seats, operator view, and replay model.
- [ ] Disable caucuses, coalitions, and secondary channels.
- [ ] Pre-register utility functions and zone of possible agreement.
- [ ] Preserve private preferences from the other Baby.
- [ ] Measure informativeness, deception, ambiguity, and agreement.
- [ ] Compare ledger confidence with revealed incentives.

### Results

| Condition | Agreement | Task value | Informativeness | Deception indicators |
|---|---:|---:|---:|---:|
| Cooperative | `TBD` | `TBD` | `TBD` | `TBD` |
| Private aligned | `TBD` | `TBD` | `TBD` | `TBD` |
| Semi-cooperative | `TBD` | `TBD` | `TBD` | `TBD` |
| Conflicting | `TBD` | `TBD` | `TBD` | `TBD` |
| No agreement | `TBD` | `TBD` | `TBD` | `TBD` |

- [ ] Utility and communication channels verified
- [ ] Coordination and negotiation claims separated
- [ ] Result committed

**Result summary:** `Not run`

---

## E40. Ephemeral Encoding and Adversarial Cryptography

**Status:** Not started

**Depends on:** E32

**Purpose:** Separate novel one-run conventions from actual cryptographic protection.

**Hypothesis:** Learned ephemeral encodings may resist history-trained classifiers but
will not necessarily match reviewed per-message-key cryptography.

### Conditions

1. plain emergent convention;
2. one-run ephemeral convention;
3. standard per-message-key ratchet control;
4. adversarial neural cryptography with training-time Eve;
5. evaluation against unseen Eve architectures.

### Procedure

- [ ] Use synthetic, non-sensitive messages only.
- [ ] Pre-register the adversary's information and capabilities.
- [ ] Generate and record both Baby nonce commitments.
- [ ] Compute and anchor the cipher-instance artifact hash.
- [ ] Verify uniqueness without claiming security from uniqueness alone.
- [ ] Evaluate history-trained and unseen adversaries.
- [ ] Compare confidentiality, integrity, and task utility separately.
- [ ] Do not publish a learned cipher as production-ready.

### Results

| Condition | Message recovery by Eve | Task success | Novelty | Security claim |
|---|---:|---:|---:|---|
| Plain convention | `TBD` | `TBD` | `TBD` | None |
| Ephemeral convention | `TBD` | `TBD` | `TBD` | Novelty only |
| Standard ratchet | `TBD` | `TBD` | N/A | Defined by reviewed protocol |
| Neural crypto, known Eve | `TBD` | `TBD` | `TBD` | Experimental |
| Neural crypto, unseen Eve | `TBD` | `TBD` | `TBD` | Experimental |

- [ ] Threat model enforced
- [ ] Security and novelty claims separated
- [ ] Cryptographic review completed
- [ ] Result committed

**Result summary:** `Not run`

---

## E50. Multi-Seed Replication and Study Closeout

**Status:** Not started

**Depends on:** E40

**Purpose:** Determine which findings survive independent seeds, operators, and
implementations.

**Hypothesis:** Findings designated primary in the pre-registration replicate under
the declared replication rule.

### Procedure

- [ ] Freeze the final protocol before replication.
- [ ] Select independent seeds before viewing results.
- [ ] Use a second operator.
- [ ] Use a second infrastructure deployment where feasible.
- [ ] Re-run all primary comparisons.
- [ ] Verify every evidence bundle independently.
- [ ] Aggregate effect sizes and uncertainty.
- [ ] Report failed and partial replications.
- [ ] Anchor the final study manifest to Base.
- [ ] Optionally anchor the study-level Merkle root to Ethereum L1.
- [ ] Publish verification instructions and anchor references.

### Results

| Primary finding | Original effect | Replication effect | Rule met |
|---|---:|---:|---|
| Communication above chance | `TBD` | `TBD` | `TBD` |
| Held-out generalization | `TBD` | `TBD` | `TBD` |
| Causal listening | `TBD` | `TBD` | `TBD` |
| Ledger predictive validity | `TBD` | `TBD` | `TBD` |
| Affect-channel result | `TBD` | `TBD` | `TBD` |
| RL versus non-RL result | `TBD` | `TBD` | `TBD` |

- [ ] Independent verification complete
- [ ] Replication rule evaluated
- [ ] Negative results included
- [ ] Final study manifest anchored
- [ ] Public report published

**Result summary:** `Not run`

---

## 9. Protocol Deviation Log

Append one row for every deviation. Do not remove resolved deviations.

| Date | Experiment / run | Deviation | Reason | Impact assessment | Decision | Reviewer |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

## 10. Integrity Incident Log

| Date | Experiment / run | Incident | Detection | Evidence preserved | Disposition | Reviewer |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — |

## 11. Research Decision Log

| Date | Decision | Alternatives | Rationale | Applies from experiment | Commit |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## 12. Publication Checklist

- [ ] All primary hypotheses were pre-registered.
- [ ] All included runs passed ledger and transcript verification.
- [ ] Invalid and aborted runs are indexed and explained.
- [ ] Effect sizes and uncertainty are reported.
- [ ] Multiple-comparison policy is documented.
- [ ] Pretrained and initially ungrounded claims are separated.
- [ ] External reward, intrinsic reward, and non-RL conditions are separated.
- [ ] Causal listening was tested rather than inferred from task success.
- [ ] Human audit ledgers are distinguished from agent-native state.
- [ ] Affect-channel leakage was tested.
- [ ] Cipher novelty is not represented as cryptographic security.
- [ ] Base anchor transactions and verification instructions are published.
- [ ] Data and model release restrictions are documented.
- [ ] Negative and null results are included.
- [ ] Independent replication status is stated.
