# Audit Cost and Utility: Local Software Qualification

Status: completed local benchmark; A03 remains in progress  
Evidence class: software qualification, not an empirical research result  
Protocol: `protocols/audit-cost-utility.v1.json`  
Receipt: `reports/research/audit-cost-utility-receipt.json`

## Question and boundary

This benchmark asks what the current audit artifacts cost to store and verify on the
local qualification host, and whether the two existing verifier implementations
reject the already-prespecified integrity challenges. It does not test whether the
agents communicate successfully, whether ledger interpretations are truthful, or
whether a public-chain anchor improves scientific validity.

Five immutable E13 software-qualification bundles were selected by run ID and by the
content-tree hashes already captured in the data/claim manifest. They contain 260
turns and 1,828 total stream events. All five remain excluded from pilot,
confirmatory, replication, and hypothesis-estimation use. Both verifiers accepted
their local contents only under the explicit unanchored qualification boundary. No
RPC endpoint was supplied and no public transaction was authorized.

## Comparators

The comparison separates storage models from executable verification work:

| Comparator | Exact meaning | What it can establish |
|---|---|---|
| Payload lower bound | JSON serialization of each event's `content` value | Approximate application payload volume only |
| Ordinary-log proxy | JSONL with stream, sequence, turn when present, event type, and content | Declared storage comparator; it has no implemented integrity guarantee |
| Signed streams | Actual five stream files, including links, hashes, signer metadata, signatures where applicable, and witness fields | Stored signed/linked record cost, but not complete bundle cost |
| Whole-input SHA-256 | One trusted digest over sorted paths and bytes of the same verifier input | Detects later byte changes relative to that trusted digest; does not validate sequence, signatures, lineage, receipts, or truth |
| Rust auditor | Independent local parsing, canonical hashes, event signatures, chain/checkpoint and receipt bindings, and attachment hashes | Cross-implementation integrity check with narrower coverage than the production verifier |
| TypeScript production verifier | Complete bundle verification, including the exported proof files and experiment-record bindings | Current production verification behavior; public-chain facts still require an RPC reader |

The ordinary-log proxy is deliberately not promoted into a new logging system. Its
purpose is to make the storage denominator explicit. Likewise, the full bundle ratio
must not be labeled "cryptographic overhead": the bundle also carries policy state,
prompts, configuration, and experiment metadata.

## Method

The protocol fixed one warm-up and five measured subprocess invocations per bundle
for each verifier. Twenty whole-input SHA-256 measurements were made per bundle. The
monotonic wall clock includes process startup for both verifiers. Runs were serial;
filesystem cache state was not controlled. Medians and p95 values are descriptive for
this six-logical-CPU, approximately 7.5-GiB host. They are not inferential performance
estimates and should not be generalized to a study deployment.

The benchmark re-hashed verifier inputs before and after measurement and aborted on
any change. `verification-report.json` was excluded from verifier input and included
only in the captured-directory total. The generated receipt records executable and
compiled-verifier hashes, host details, every timing sample summary, input-tree
hashes, and per-verifier coverage counters.

## Storage result

| Layer or component | Bytes across five bundles | Bytes per turn | Share of verifier input |
|---|---:|---:|---:|
| Payload lower bound | 546,418 | 2,101.61 | 2.65% |
| Ordinary-log proxy | 687,916 | 2,645.83 | 3.33% |
| Actual signed streams | 2,053,633 | 7,898.59 | 9.94% |
| Integrity core | 12,117,263 | 46,604.86 | 58.68% |
| Policy state | 6,437,525 | 24,759.71 | 31.17% |
| Experiment metadata and analysis | 41,793 | 160.74 | 0.20% |
| Complete verifier input | 20,650,214 | 79,423.90 | 100.00% |

Actual signed streams are 2.985× the declared ordinary-log proxy, an incremental
1,365,717 bytes or 198.53% for these five small runs. Complete verifier inputs are
30.019× the proxy. That larger ratio is driven principally by integrity structures
and policy snapshots: proof files alone account for 11,795,564 bytes, while
checkpoints account for 309,373 bytes. This small-run format stores many individual
proof files, so the ratio is sensitive to checkpoint frequency, run length, and file
layout. It is not a stable asymptotic estimate.

## Offline verification result

| Bundle | Events | Proof files checked by production verifier | Whole-input SHA-256 median | Production verifier median | Rust auditor median |
|---|---:|---:|---:|---:|---:|
| Fixed glyph | 333 | 2,736 | 48.964 ms | 982.747 ms | 39.159 ms |
| Fixed token | 345 | 3,095 | 49.712 ms | 1,027.571 ms | 41.201 ms |
| Generative bitmap | 378 | 3,140 | 52.751 ms | 1,156.726 ms | 47.084 ms |
| Generative canvas | 381 | 3,146 | 52.136 ms | 1,069.228 ms | 47.236 ms |
| Generative tone | 391 | 3,274 | 53.950 ms | 1,108.121 ms | 49.963 ms |

Both verifiers accepted all five local unanchored bundles. The production verifier
checked 15,391 exported proof files in total. The Rust auditor checked the same 1,828
stream events and 171 checkpoints but does not implement the exported proof-file
pass; its faster time is therefore evidence about a narrower independent audit, not
an equivalent-work performance advantage. Whole-input hashing reads the complete
input tree but supplies only byte-change detection relative to an already trusted
digest.

## Integrity-challenge utility

The benchmark binds to the prior frozen integrity-challenge receipt rather than
creating new mutation definitions after observing performance. Both implementations
accepted the unchanged fixture and rejected each of six challenges: event-content
mutation, attachment-byte mutation, lineage injection, wrong-chain substitution,
false receipt, and an unanchored tail. This yields 12 observed rejections in 12
implementation-by-case challenges.

That count is a deterministic conformance result from one fixture per case. It is not
a statistical sensitivity estimate, does not sample an attacker distribution, and
does not show that ordinary logs would fail every such mutation. A trusted whole-file
digest would detect changed bytes, but it would not independently adjudicate the
semantic and structural rules that the verifiers apply.

## What remains for A03

A03 stays `IN_PROGRESS`. Its local software-qualification component is complete, but
three preconditions remain:

1. measure actual deterministic simulated-commitment submission, confirmation, and
   receipt-verification latency; monetary fee remains not applicable;
2. repeat cost measurement on prospectively registered pilot and confirmatory
   bundles at the selected checkpoint schedule and study scale; and
3. execute the registered ordinary-log, signed-log, and full-audit comparison on the
   same study inputs before drawing an incremental scientific-value conclusion.

The present public-anchor result is exactly `not-measured`: zero transactions, null
latency, and null fee. Local fake-chain receipts cannot close that gap.

## Reproduction

After building the TypeScript workspace and the release Rust auditor, regenerate the
host-specific receipt deliberately with:

```sh
pnpm run benchmark:audit-cost
```

Routine checks validate the stored receipt without rerunning timing:

```sh
pnpm run audit:audit-cost
```

Regeneration changes descriptive timing values and should be committed only as a new
declared benchmark snapshot. The receipt checker verifies the protocol hash, evidence
boundary, bundle count, storage accounting, timing ordering, verifier coverage
distinction, mutation count, and the absence of a fabricated public anchor result.
