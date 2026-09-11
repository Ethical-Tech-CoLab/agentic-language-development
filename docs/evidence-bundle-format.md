# Evidence Bundle Format

> **Status:** Implementation contract for ALD-016 (export) and ALD-015 (verifier).
> Authoritative layout: [LEDGER-INTEGRITY-DESIGN.md §13](../LEDGER-INTEGRITY-DESIGN.md#13-evidence-bundle)
> and [SPECIFICATION.md §13.2](../SPECIFICATION.md#132-evidence-bundle-structure).
> This document fixes the byte-level details those sections leave open so that a
> third party can write an independent verifier.

## 1. Layout

```text
<bundle-root>/
  run-manifest.json              canonical JSON, RunManifestSchema
  baby-a-ledger.jsonl            one canonical signed LedgerEvent per line
  baby-b-ledger.jsonl            one canonical signed LedgerEvent per line
  channel-transcript.jsonl       one canonical signed ChannelEvent per line
  affect-transcript.jsonl        present only if affect events exist
  audit-ledger.jsonl             present only if generated-analysis entries exist
  turn-records.jsonl             one canonical signed TurnRecord per line
  intervention-log.jsonl         one canonical InterventionEvent per line (unsigned chain)
  checkpoints/
    000000.json                  canonical signed CheckpointManifest, sequence 0
    000001.json
  proofs/
    inclusion/<tree>-<sequence>-at-<checkpoint>.json    InclusionProofSchema
    consistency/<tree>-<from>-<to>.json                 ConsistencyProofSchema
  anchors/
    base-receipts.json           canonical JSON array of AnchorReceiptSchema
  configuration/
    run-config.json              canonical JSON RunConfig
  prompts/
    learner-contract.<track>.v<n>.md   exact contract texts referenced by the run
  policies/
    <role>-policy-initial.json   trainable adapter state before the first turn
    <role>-policy-<turn>.json    optional exported policy checkpoints
  experiment-record.json         { current, history[] } (ExperimentRecordFileSchema)
  verification-report.json       written by the verifier, never by the exporter
```

Every `*.json` file is RFC 8785 canonical JSON followed by a single `\n`. Every
`*.jsonl` line is the exact `canonical_json` column stored in SQLite, followed by
`\n`, in ascending `sequence` order with no gaps. Exporting the same run twice
without intervening writes MUST produce byte-identical files.

## 2. Hash and Signature Encodings

| Kind | Encoding | Example |
|---|---|---|
| SHA-256 | `sha256:` + 64 lowercase hex | `sha256:9f86…` |
| Ed25519 signature | `ed25519:` + base64 of 64 bytes | `ed25519:MEUC…` |
| Ed25519 public key | `ed25519-pub:` + base64 of the raw 32-byte key | `ed25519-pub:11qY…` |
| Genesis previous hash | `sha256:` + 64 zeros | |

Domain-separated hashing is `SHA-256(utf8(domain) || sep || payload)` where `sep`
is `0x00` except for Merkle interior nodes (`0x01`). The domain strings are the
constants in `packages/types/src/domains.ts` (`HASH_DOMAINS`).

## 3. Event Hashing

For every signed stream the entry hash is computed as:

1. Take the complete signed event object.
2. Delete `entryHash` and `writerSignature`.
3. Serialize with RFC 8785 (JCS).
4. `entryHash = sha256(domain || 0x00 || utf8(canonical))` using the stream's
   hash domain (`STREAM_HASH_DOMAIN`).
5. `writerSignature = Ed25519.sign(privateKey, rawBytes(entryHash))` over the
   32 raw digest bytes, by the signer domain for that stream (`STREAM_SIGNER`).

`intervention-log.jsonl` follows steps 1-4 with `entryHash` only; it is unsigned.

Chains: sequences start at `1`; the first event's `previousEntryHash` is the
genesis hash; every later event's `previousEntryHash` equals the previous
event's `entryHash` in the same stream and run.

Cross-bindings (LEDGER §6) that the verifier MUST check:

- `ChannelEvent.senderLedgerSequence` / `senderEntryHash` reference an existing
  sender-ledger event with `eventType: "intention.recorded"` at that sequence
  (Baby-originated accepted events only).
- Receiver `interpretation.recorded` ledger events carry `channelEventHash`
  equal to an existing `ChannelEvent.entryHash` whose `deliveryReceipt.recipient`
  is that Baby.
- `TurnRecord.channelEventHash` references the turn's channel event when one exists.
- `TurnRecord.probeHash`, when present, references exactly one applied
  `causal-probe` intervention on the same evaluation turn. The verifier rebuilds
  the probe hash, both recorded artifact hashes, and the ablation/substitution
  transformation independently.
- `TurnRecord.repairAttempt`, when present, references one failed primary turn
  and one `repair-turn` intervention. The repair must occur on the scheduled
  next turn, retain the original phase and `scenarioRef`, and use attempt `1`.
- `deliveryReceipt.deliveredArtifactHash` equals `publicArtifactHash` for
  accepted deliveries.

For each trainable Baby, checkpoint 0 commits a `runtime-attestation` intervention
whose `initialPolicyHash` equals the policy-checkpoint-domain hash of
`policies/<role>-policy-initial.json`. These files contain the exact independently
seeded parameters before any turn or update.

## 4. Artifact Hashes

- `publicArtifactHash` = `sha256(carrierMark || 0x00 || utf8(carrierMode) || 0x00 || utf8(canonical(artifact)))`.
  For the `disabled` condition the artifact is canonical `null`.
- `babyProposalHash` = `sha256(babyProposal || 0x00 || utf8(canonical(AgentActionProposal)))`.
- `probeHash` = `sha256(causalProbe || 0x00 || utf8(canonical(ArtifactProbe)))`.
- Rejected events store `publicArtifactHash` = `sha256(rejectedPayload || 0x00 || utf8(canonical(rejectedPayload)))`
  and never the raw payload.

## 5. Merkle Trees (LEDGER §7)

RFC 6962 ordered tree over leaves in sequence order:

- `leafHash = sha256(merkleLeaf || 0x00 || uint64BE(sequence) || rawBytes(entryHash))`
- `nodeHash = sha256(merkleNode || 0x01 || rawBytes(left) || rawBytes(right))`
- The root of an empty tree is `sha256(merkleNode || 0x01)` over no children,
  i.e. the hash of the domain and separator alone. A checkpoint records
  `treeSize: 0` and this empty root for streams with no events yet.
- Inclusion proofs and consistency proofs follow RFC 6962 §2.1.1 and §2.1.2
  exactly, using 0-based `leafIndex = sequence - 1`.

## 6. Checkpoint Manifests (LEDGER §8)

`checkpointHash = sha256(checkpoint || 0x00 || utf8(canonical(manifest without checkpointHash, witnessSignature)))`.
`witnessSignature` is over the raw digest bytes by the `witness` signer.
Checkpoint `0` is created at run initialization with `previousCheckpointHash`
equal to the genesis hash. `auxiliaryTrees` is always present; it contains an
entry for each auxiliary stream that has at least one event (`affect`, `audit`,
`turns`, `intervention`). The intervention entries are unsigned, but their
tree prefix is protected by the checkpoint witness signature. A verifier MUST
validate each audit entry's `sourceEntryHash` against the named Baby's exported
`agent-native-ledger` event before accepting that auxiliary stream. An accepted
interpreter batch creates an `analysis` checkpoint over the new audit prefix.
A verifier MUST
read an auxiliary tree that is absent from a
manifest as the empty tree (`treeSize: 0`, the empty root), so a consistency
proof from such a checkpoint to a later one where the tree first appears is
well-formed with `fromSize: 0`. A verifier MUST reject any auxiliary tree whose name is not declared
in `run-manifest.json` `streams[].treeName`; every signed stream must also have
its signer's public key listed in `signers`.

## 7. Run Manifest

`run-manifest.json` binds the run to its keys and streams:

- `signers[]`: every signer domain used by the run with `keyId` and `publicKey`.
- `streams[]`: for each exported stream its file name, hash domain, signer
  domain (absent for `intervention`), and checkpoint `treeName` (absent for
  `intervention`).
- `configurationHash` = `sha256(runConfig || 0x00 || utf8(canonical(RunConfig)))`
  and MUST equal the hash of `configuration/run-config.json` and the
  `runConfigurationHash` in every checkpoint.
- `runIdHash` = `sha256(runId || 0x00 || utf8(runId))`.
- `claimBoundaryStatement` MUST equal the SPEC §5.1 or §5.2 sentence for
  `deploymentMode` verbatim.
- Derived runs repeat `parentRunId`, `derivedFromCheckpointHash`, and both
  `initialPolicyRefs` from `configuration/run-config.json`; root runs omit all
  four lineage values.
- `preRegistration` (optional, `PreRegistrationBindingSchema`) records how the
  run was bound under SPEC §15.1: `registrationClass` (`qualification` or
  `confirmatory`), the `preRegistrationHash` it binds, the external
  registration URL/id when one exists, the pre-run anchor of that hash when one
  exists, and a verbatim `label`. A `confirmatory` binding MUST carry both the
  external registration and a `confirmed` pre-run anchor; a verifier that finds
  a `confirmatory` binding without them MUST fail the run. A bundle without this
  field is a run created before ALD-071 completed and is read as
  `qualification`.
- A derived export repeats both learner `initialPolicyRef` values as
  `initialPolicyRefs`. The verifier requires the immutable parent export via
  `--parent-bundle`, confirms the named parent checkpoint exists, resolves both
  references inside the parent's `policies/` directory, and checks the child's
  checkpoint-0 initialization attestation against those artifacts.

## 8. Anchor Receipts

`anchors/base-receipts.json` is a canonical JSON array. Each receipt binds one
`checkpointHash` to one transaction: `chainId`, `transactionHash`, `from`, `to`,
`inputData` (must equal the 32-byte checkpoint digest, `0x` + 64 hex), block
number and hash once mined, `status`, `confirmations`, `finalityPolicy`, and the
label of the RPC endpoint used. The verifier recomputes the final checkpoint
hash and compares it with `inputData`; chain retrieval is performed only when an
independent RPC URL is supplied, and the report records whether that check ran.

## 9. Verification Report

The verifier writes `verification-report.json` conforming to
`VerificationReportSchema` (SPEC §11.10) with `exitCode: 1` on any failure and
lists every gap, fork, and event after the last anchored checkpoint under
`gaps`, `forks`, and `unanchoredTailReported`.

## 10. Analysis Attachments

Analysis outputs that are evidence *about* a run but not events *of* the run —
the SPEC §15.2 intervention-suite results, the §6.5 semantic-leakage battery,
side-channel and observation red-team audits, carrier/affect leakage
evaluations, E40 encoding-scheme events, curriculum transitions, drift
evaluations — live under `analysis/`:

```text
<bundle-root>/
  analysis/
    index.json                     canonical JSON, BundleAttachmentIndexSchema
    <kind>/<name>.json             canonical JSON attachments
```

- `analysis/index.json` lists every file under `analysis/` except itself as a
  `BundleAttachmentSchema` entry: relative `path`, plain `sha256:<hex>` of the
  file bytes (no domain separator, so any tool reproduces it), `kind`,
  `analysisVersion`, `producedAt`, and an optional `boundBy`. The exporter
  writes the index even when the attachment list is empty.
- `boundBy` names a chained evidence entry (`audit`, `intervention`, or `turns`
  stream) whose content carries the same `sha256`. An attachment produced while
  the run was live is bound this way; it is covered by the checkpoint and
  anchor chain only when that entry is inside the anchored tree prefix. An
  attachment without `boundBy` was produced after sealing;
  it is tamper-evident (its hash is listed) but not chain-bound, and a verifier
  MUST report it as an *unbound analysis attachment*, never as anchored evidence.
- A verifier MUST fail the bundle when an entry's `sha256` does not match the
  file, when a file under `analysis/` is not listed, or when a listed file is
  missing. It MUST NOT interpret attachment contents; interpretation is the
  researcher's job (SPEC §15.1: the notebook is authoritative for scientific
  status).
- `carrier-leakage` attachments record `carrier-leakage-v1`, per-mark reuse and
  structural-feature metrics, explicit recognizable-glyph and unintended-feature
  probe decisions, and the ungrounded-language claim gate. Their probe thresholds
  must exactly match the hash-bound `RunConfig.carrierLeakageProbePlan`; a failed
  analysis blocks that claim, not the integrity validity of the bundle.
- Attachments never contain raw observations, raw rejected payloads, private
  keys, or Baby-visible text; the same §13.6 privacy rules as every other bundle
  file apply.
- The latest `ExperimentRecord.analysisAttachmentRefs` lists the hashes of all
  attachments currently in the bundle. Earlier append-only record versions may
  list only the attachments that existed when that version was written.

## 11. Independent integrity cross-check

`tools/integrity-auditor` is a read-only Rust implementation of the core byte-level
checks. It does not import the TypeScript hashing, Merkle, evidence, or verifier
packages. It independently checks canonical JSON bytes, event chains, Ed25519
signatures, RFC 6962 roots at every checkpoint, checkpoint hashes and signatures,
configuration and lineage bindings, local anchor-receipt bindings, unanchored tails,
and analysis-attachment byte hashes. It does not query a public chain or interpret
scientific content, so it supplements rather than replaces `ald-verify`.

Run `pnpm run challenge:integrity` to create a fresh exporter-produced fixture and
require the production verifier and Rust auditor to agree on the unchanged export
and on deliberate event, attachment, lineage, chain, receipt, and tail mutations.
