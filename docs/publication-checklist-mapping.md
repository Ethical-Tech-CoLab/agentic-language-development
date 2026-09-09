# Publication checklist mapping

This table maps every item in `EXPERIMENT-NOTEBOOK.md` §12. A
`software-verifiable` row has a deterministic implementation or evidence check.
A `research-execution` row depends on the contents, reporting choices, or
judgment of a completed study; the linked software can support that work but a
green build does not assert that the publication has satisfied it.

| §12 checklist item | Classification | Software mapping and boundary |
|---|---|---|
| All primary hypotheses were pre-registered. | research-execution | ALD-071 binds a supplied registration before a confirmatory run; researchers must verify that the submitted record covers every primary hypothesis. |
| All included runs passed ledger and transcript verification. | research-execution | ALD-015, ALD-021, and Gate G1 verify individual bundles; publication inclusion remains a corpus-level decision. |
| Invalid and aborted runs are indexed and explained. | research-execution | ALD-024 and ALD-061 preserve terminal states and failure evidence; authors must include and explain the complete study index. |
| Effect sizes and uncertainty are reported. | software-verifiable | ALD-072 and Gates G3–G5 emit effect sizes and uncertainty fields without drawing a conclusion. |
| Multiple-comparison policy is documented. | software-verifiable | ALD-072 implements the pre-registered Holm-Bonferroni policy across primary metrics. |
| Pretrained and initially ungrounded claims are separated. | software-verifiable | ALD-054 and ALD-057 enforce track and semantic-leakage claim boundaries; Gate G2 checks them. |
| External reward, intrinsic reward, and non-RL conditions are separated. | software-verifiable | ALD-023 validates learning-signal configuration; ALD-042, ALD-045, and ALD-046 implement the distinct conditions checked by Gate G3. |
| Causal listening was tested rather than inferred from task success. | research-execution | ALD-072 and Gate G2 provide registered ablation/substitution probes; authors must actually run and report them. |
| Human audit ledgers are distinguished from agent-native state. | software-verifiable | ALD-064 signs, labels, routes, and exports generated analysis separately; Gate G2 references that boundary. |
| Affect-channel leakage was tested. | research-execution | ALD-033 and Gate G3 supply the six-display conformance and leakage tooling; a publication must run it on its study data. |
| Cipher novelty is not represented as cryptographic security. | software-verifiable | ALD-070 and Gate G5 enforce the production-crypto import and claim boundary. |
| Base anchor transactions and verification instructions are published. | research-execution | ALD-020–ALD-022 and ALD-079 provide receipts, verification, and operational documentation; authors must publish the study-specific transaction references. |
| Data and model release restrictions are documented. | research-execution | ALD-016 exports provenance and ALD-080 defines release review; legal, privacy, model-license, and data-access restrictions require study-specific judgment. |
| Negative and null results are included. | research-execution | ALD-072's E50 aggregate never drops failed or partial replications, but authors remain responsible for complete reporting. |
| Independent replication status is stated. | research-execution | ALD-028, ALD-072, and Gate G5 represent independent seeds and replication status; independence and the publication statement require researcher attestation. |

The mapping is deliberately not a publication approval. In particular,
statements such as “results support the stated hypothesis,” whether exclusions
were scientifically justified, and whether interpretation is appropriately
calibrated are research-judgment calls outside the software backlog.
