# Decision-model recommendation: offline experiment annotation

Date: 2026-10-11. Status: research proposal, no measured model results.
Scope: this repository. Public evidence only.

## Preserve the experiment

Reviewed [README](https://github.com/Ethical-Tech-CoLab/agentic-language-development/blob/feb68708333d2a1212bc7789480fa48e999ae643/README.md),
revision `feb68708333d2a1212bc7789480fa48e999ae643`.
This assessment is README-led, not an audit of agent isolation.

The project describes isolated agents, a constrained symbol channel, a
monitor-only BabySitter, and chronological independent ledgers. The foundation
implementation is not evidence of completed language-emergence experiments.

**Do not insert a natural-language decision model into the communication,
reward or selection loop.** Doing so could leak human-language priors and
invalidate the research intervention.

## Bounded use outside the causal loop

After runs are sealed, use a separate read-only pipeline to prioritize
experiment records for human annotation. Candidate tasks include matching
researcher-written observations to an explicit rubric, spotting unsupported
interpretations, and finding similar annotation examples.

Keep model interpretation in a derived annotation layer. Never rewrite agent
messages or original ledgers. Explicitly permit unclassifiable/insufficient
evidence; do not label unfamiliar symbols as human-like language by default.

## Candidate methods

Begin with deterministic event summaries and blind human annotation. Test a
local classifier or embedding model only where it answers a bounded annotation
task. Jev, Microsoft-Decision-1 and Sage can be external comparison conditions
on approved public records, not agents inside the experiment.

The [TypeSafe building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md)
explains the narrow-decision pattern. It does not establish the validity of
using Jev as a scientific oracle. The proprietary models' exact checkpoints
are not locally available; reproducible offline work needs a separately
licensed local baseline.

## Evaluation

Use run/seed/condition-disjoint splits, blinded annotators and an adjudication
protocol. Measure inter-rater agreement, alert precision/recall, calibration,
model/human disagreement, annotation time and cost. Preserve condition labels
outside the judging context where blinding requires it.

Check prompt/order sensitivity and misleading natural-language glosses.
Validate that no annotation output feeds future agent context, rewards,
selection or training. Run-level effects must not be assessed as independent
message-level samples.

## Release gate and next step

No mutation of original ledgers or communication paths; no generation of
experiment outcomes; no claim that the annotator establishes language
emergence. Start with archived public fixtures and save annotations separately.
Adopt only if blinded evaluation demonstrates useful review assistance without
changing the experimental construct. Default rollback is no semantic annotator.
