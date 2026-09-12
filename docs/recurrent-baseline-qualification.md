# Recurrent Baseline Qualification

Status: software qualification; not an experiment result

This document locks the scientific learner implementation used by the recurrent
`scratch-rl` baseline and its capacity-matched `self-supervised` comparison. The
registered E11 and E12 experiments remain unstarted. Gradient checks, toy learning,
container execution, and sealed bundle verification establish executable behavior;
they do not establish emergent communication or support a hypothesis.

## Locked model

Both tracks use `gru-actor-critic-v1`, implemented in TypeScript behind the existing
learner adapter. Keeping this small numerical core in the protocol runtime makes its
complete parameters, optimizer moments, recurrent checkpoint state, and update count
canonical and independently inspectable without adding a native FFI or tensor-runtime
boundary. The reference configuration is:

| Property | Locked value |
|---|---|
| Recurrent cell | one GRU shared by sender and receiver paths |
| Hidden width | 16 float64 values |
| Input | role bit, numeric candidate feature, public message symbols |
| Heads | sender symbols, receiver type, scalar value |
| Initialization | independently seeded Xavier-uniform weights; zero biases and hidden state |
| Optimizer | independent Adam state per learner; learning rate 0.003, betas 0.9/0.999, epsilon 1e-8 |
| Scratch objective | one-step-truncated PPO-style clipped actor loss plus value MSE |
| PPO settings | four epochs, clip 0.2, value coefficient 0.5, gradient-norm cap 1 |
| Reward-free objective | partner-message predictive cross-entropy from numeric features and public symbols |
| Serialization | parameters, both Adam moments and step, sender/receiver checkpoint hidden state, update count |
| Evaluation | update path disabled; transient live hidden state excluded from export; checkpoint export must remain constant |

The current four-choice, one-symbol Mode R fixture has 4,049 parameters per learner.
Both tracks instantiate the entire shared core, including heads unused by a particular
loss, so parameter capacity is exactly matched rather than estimated from active
weights. Runtime memory accounting covers parameters, both Adam moments, and live plus
checkpoint hidden states. Experiment reports must additionally record process/container
memory and elapsed compute; this in-model count is not a whole-system resource claim.

## Signal boundary

Scratch RL may update only from the learner's own sampled action and its locally
delivered scalar reward. Self-supervision accepts no scalar reward: its update records
contain numeric candidate features and public message symbols, and the adapter refuses
a non-null reward. Receiver self-training uses its own current argmax candidate rather
than the environment's intended target. That choice avoids a hidden task label but can
reinforce an incorrect interpretation; E12 must measure the consequence rather than
assuming convergence.

## Qualification assertions

The blocking unit and adapter checks establish:

- deterministic replay for the same seed and distinct parameters for distinct learner
  seeds;
- optimizer isolation by mutating one model and proving another model is unchanged;
- central-difference agreement for the largest predictive gradient component;
- nonzero PPO-style reward-to-parameter and predictive-loss updates;
- a bounded reward-free toy mapping improves above its initial score;
- exact parameter, optimizer, recurrent-state, and registry restore;
- witnessed policy checkpoints through the shared adapter contract;
- byte-equivalent policy export throughout learning-disabled evaluation; and
- structural reward refusal and absence of outcome labels from self-supervised updates.

`pnpm run test:mode-r-study` additionally runs the two recurrent tracks in distinct
learner containers through the real controller, Gateway, SQLite writer, checkpoint
service, local qualification anchor, exporter, and production verifier. The resulting
bundles are then checked by the independent Rust auditor. The local fake-chain receipt
is deliberately classified as software evidence, never as a public-chain transaction
or research result.

## Known limitations before E11/E12

- Training uses one-step truncated recurrence; it does not propagate gradients across
  earlier turns. This is a locked model choice, not full sequence PPO.
- The deterministic TypeScript implementation prioritizes inspectability over
  accelerator throughput and is intended for the small registered baseline.
- The toy learnability threshold is a regression guard, not an empirical effect size.
- Equal parameter count does not alone equalize wall time, update count, information
  access, or effective optimization difficulty. The experiment protocol must match and
  report those quantities.
- The recurrent qualification uses bounded turns. Publication-facing E11/E12 require
  disjoint seeds, locked scenarios and analyses, required repository registration, full
  sample accounting, and independent repetition.
