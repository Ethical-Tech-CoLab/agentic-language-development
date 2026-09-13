# A Verifiable Experimental Platform Now Exists; Agent-Language Findings Remain Open

Phase-one development update · September 4–13, 2026  
Evidence cutoff: September 13, 2026  
Current decision: suitable for a technical progress review, not an empirical-result
or publication-readiness claim

Research status: 2 qualified (software), 1 failed qualification attempt, 0 in progress, 16 not started; 9 open campaign blockers.

## Executive summary

The repository arrived with a developed research concept, a normative specification,
an experiment notebook, initial evidence-integrity code, and a pre-results manuscript.
Since the September 4 handoff, the work has concentrated on making that design
executable and auditable.

- The system now has an integrated two-agent runtime, a controlled communication
  Gateway, private learner state, append-only signed evidence, checkpoints, export,
  recovery, independent verification, and bounded container-isolation paths.
- Two prospectively registered software qualifications have completed. E00 passed a
  five-slot integrity mutation suite. E01 passed five slots containing 560 signed
  isolation attempts and controls. These results qualify specific software
  properties; they are not evidence that agents developed a language.
- The first registered E02 leakage-qualification attempt failed safely. It retained
  465 turns and 930 delivered observations, then paused after five consecutive
  response timeouts. It never reached restore or probe analysis, and its remaining
  four slots were not run.
- No bundle is currently eligible as a pilot, confirmatory result, or replication.
  The scientific questions about convergence, grounding, composition, causal
  listening, and transfer therefore remain open.

The strongest phase-one outcome is a research instrument with unusually explicit
claim boundaries and inspectable failure records. The next milestone is to correct
and prospectively requalify E02 without weakening its timing or safety controls.

## Starting point and contribution boundary

The comparison baseline is commit `feb6870`, the final repository snapshot before
the stated handoff date. That baseline already contained the research premise,
specification, ordered experiments, initial implementation, manuscript, and book
presentation. Those materials are the inherited foundation and are not presented as
new work in this update.

Repository history shows no post-baseline commit dated September 4–6. The first
recorded post-handoff change is dated September 7. This update reports repository
evidence and does not infer undocumented activity or personal authorship from commit
metadata.

## What was built after the handoff

```text
shared synthetic scenario
          |
          v
 Nursery controller -----> signed evidence, checkpoints, export, replay
      |       |
      |       +----------> independent TypeScript and Rust verification
      |
      +---- controlled Gateway ----+
      |                             |
 isolated Baby A                isolated Baby B
 private policy/ledger          private policy/ledger
```

The implementation added an end-to-end experimental path around the original
design. The Nursery controls turns and outcomes. Learners have separate private
state. The Gateway is the only intended communication route and applies the carrier,
budget, rejection, and automatic-pause rules. The evidence layer commits ordered
events, interventions, policies, and analysis attachments so a later verifier can
detect specified mutation, deletion, reordering, signature, or lineage failures.

The work also added experiment-readiness gates, scenario and allocation contracts,
causal-intervention seams, frozen-model and scratch-learning adapters, carrier
qualification, recovery checks, and a researcher console. These are important
capabilities, but the distinction below is essential: implementation shows that a
mechanism exists; software qualification shows that a bounded test passed; neither
alone answers a behavioral hypothesis.

## Milestones and evidence

| Period | Recorded advance | Strongest supporting evidence | What it does not establish |
|---|---|---|---|
| September 7 | Integrated runtime, Gateway, evidence writer, checkpointing, anchoring interface, verifier, Nursery orchestration, and initial experiment harnesses | Commits `dff341b` through `6bbe22c`; historical qualification report | Eligible research observations or independent replication |
| September 8–9 | Prospective controls, scenario quarantine, intervention and lineage evidence, Mode R isolation, side-channel checks, research console, registration compiler, and real frozen-model adapter exercise | Commits `fcef18f` through `d1b4eab`; frozen-model qualification receipt | Language-naive behavior, production capacity, or a model comparison |
| September 11 | Exact-commit topology, recurrent learner, learned-carrier mechanism, lifecycle, recovery, and integrated-candidate qualifications | Receipts for commits `97a33be`, `6871f8d`, `886dd53`, `39a6e45`, and `b2b119c` | Registered E11/E13 findings, causal language use, or generalization |
| September 12–13 | Simulation-only governance and registration; E00 and E01 registered qualifications; E02 packet and first attempted run | E00 commit `6a3faa8`, E01 commit `4ba1f27`, E02 commit `895d59a`; tracked receipts | Public timestamping, external custody, or behavioral findings |

The E01 total of 560 is a corpus of signed attempts and controls. It includes 100
Gateway rejection cases, 50 host/path decisions, 400 captured transport responses,
five allowed-delivery controls, and five planted-detector records. It must not be
described as 560 blocked attacks.

The clean E02 execution commit passed 1,933 automated tests across 149 files plus the
registered static, build, Rust, secret-scan, and root dependency gates. That receipt
belongs to exact commit `895d59a`; it is not a fresh validation of this update and did
not prevent the long-running timing failure.

## What the system can credibly demonstrate

The current repository can demonstrate a bounded local workflow in which two roles
run separately, exchange constrained artifacts through a Gateway, write signed and
hash-linked records, produce checkpoints and exports, restore recorded state, and
submit those exports to two verifier implementations. It can also demonstrate that
registered integrity mutations are rejected and that the finite E01 isolation corpus
was handled as specified.

The campaign uses synthetic observations and zero external spend. Repository-native
registration plus deterministic simulated commitments bind exact packet bytes to
execution order without requiring funds. They do not provide an independent public
timestamp, decentralized custody, or economic finality. Actual behavioral claims
would still require actual eligible executions; simulated money never means
simulated research outcomes.

## Failure, limitations, and lessons

E02 provides the most useful current failure lesson. The Mode R proxy pads turn-path
calls to a normalized 1,000 ms schedule while the Nursery enforces a 1,000 ms response
deadline around those calls. The retained evidence shows 223 timeout rejections in
465 turns, ending with five consecutive timeouts and a safety pause. This timing
interaction is the leading implementation hypothesis, not yet a demonstrated root
cause. It must be reproduced without consuming another registered seed before a
correction is selected.

The broader campaign is also not resource-ready. Maximum preallocated pools project
well beyond the approved local storage and compute envelope; exact sample prefixes
still depend on blinded pilots and frozen power calculations. Sixteen experiment
cards remain unstarted, 160 packet bindings remain unresolved, and independent
methods and citation review have not occurred.

Internal criticism, extensive tests, and dual software verifiers improve confidence
but are not independent scientific review. Development was substantially assisted by
AI tools; this update does not treat that assistance as independent verification or
assign unsupported personal authorship to individual changes.

## Next milestone

The next milestone is a fresh, prospectively registered E02 qualification that
completes all five slots, the planned restore boundary, all 60 leakage decisions, and
both verifier passes within a measured resource envelope.

Before registration, the timing interaction must be reproduced, corrected without
weakening normalization or the safety pause, and qualified on the exact container
topology. The failed packet, run identifier, and seeds remain historical and cannot
be reused. Only after E02 qualifies should the project proceed to chance controls,
blinded feasibility pilots, exact sample-size selection, and behavioral experiments.

## Phase-one conclusion

Phase one has produced a substantial, inspectable research platform and two bounded
software qualifications. It has also produced a well-preserved failed qualification
that exposed a long-run reliability issue missed by short smoke tests. The honest
status is therefore strong engineering progress with research results still open.

The accompanying [evidence appendix](phase-one-evidence-appendix.md) maps each claim
to its commit, receipt, evidence availability, and verification command. The
[demonstration guide](../docs/phase-one-demonstration-guide.md) provides a short
evidence-preserving review path.
