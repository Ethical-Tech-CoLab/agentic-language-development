# Baby Ledger Integrity Design

> **Document type:** Technical design
>
> **Status:** Proposed
>
> **Purpose:** Make each Baby ledger append-only, sequentially verifiable, and
> externally anchored so later modification is detectable.

## 1. Integrity Claim

The system should describe the Baby ledgers as **cryptographically append-only and
externally anchored**, not absolutely immutable.

After a checkpoint is anchored and reaches the selected chain-finality threshold, an
auditor can verify that:

- every disclosed entry in the committed prefix is unchanged;
- entries remain in their original sequence;
- no entry in the committed prefix was inserted, deleted, or reordered;
- Baby A's ledger, Baby B's ledger, and the channel transcript belong to the same
  checkpoint;
- the checkpoint existed no later than the anchoring block;
- later checkpoints extend, rather than replace, earlier committed prefixes.

The design does **not** prove that:

- the original entry was truthful;
- a Baby's hypothesis accurately describes its policy;
- no event was omitted before it reached the ledger writer;
- an unanchored tail was not rewritten before the next checkpoint;
- a claimed wall-clock timestamp is exact;
- an on-chain commitment reveals the private ledger content.

These limits must appear in every research report.

## 2. Recommended Structure

Use four layers:

1. **Sequential event log:** Each accepted ledger event contains a sequence number and
   the hash of the previous event.
2. **Ordered Merkle tree:** Entry hashes become ordered Merkle leaves, allowing compact
   inclusion and append-only consistency proofs.
3. **Signed checkpoint manifest:** A Nursery witness signs the roots and sizes of both
   Baby ledgers and the channel transcript.
4. **Public-chain anchor:** The checkpoint manifest hash is periodically written to
   Base. Optional higher-level checkpoints can also be written to Ethereum L1.

```text
Baby A events ---- hash chain ----\
                                  \
Baby B events ---- hash chain ------ checkpoint manifest ---- signature
                                  /           |
Channel events --- hash chain ----            |
                                               v
                                      ordered Merkle roots
                                               |
                                               v
                                      Base transaction anchor
                                               |
                                               v
                                      optional Ethereum L1 rollup
```

An append-only Merkle tree is preferable to a Merkle trie for this requirement. A
trie is optimized for proving mutable key/value state. The Baby ledger needs ordered
history, prefix size, inclusion proofs, and consistency proofs.

## 3. Authoritative Local Store

Use SQLite as the authoritative local evidence store for the first implementation.
It is embedded, transactional, and requires no separate database service.

Recommended tables:

- `ledger_events`;
- `channel_events`;
- `checkpoint_manifests`;
- `anchor_receipts`;
- `run_metadata`.

Enable WAL mode and serialize writes through one evidence-writer service. Database
permissions and triggers should reject `UPDATE` and `DELETE` operations on event
tables. These controls prevent accidental mutation; cryptographic commitments detect
mutation by a privileged operator.

Each accepted turn should write its public channel event and required private ledger
event in one SQLite transaction. A message is not released to the other Baby until
that transaction commits.

Export canonical JSON Lines files for portable evidence and independent verification.
SQLite is the transactional store; the JSONL files are the archival interchange
format.

## 4. Canonical Ledger Event

Each Baby maintains an independent event sequence beginning at `1`.

Illustrative event:

```json
{
  "version": 1,
  "runId": "run-2026-08-24-001",
  "babyId": "A",
  "sequence": 42,
  "turn": 18,
  "eventType": "hypothesis.revised",
  "subjectId": "sha256:7e...",
  "content": {
    "hypothesis": "private-agent-native-or-audit-content",
    "confidence": 0.78,
    "evidenceRefs": ["channel:31", "outcome:18"]
  },
  "blindingNonce": "base64:...",
  "previousEntryHash": "sha256:91...",
  "channelEventHash": "sha256:b4...",
  "recordedAt": "2026-08-24T21:30:00.000Z",
  "writerKeyId": "baby-a-ledger-writer-v1"
}
```

The authoritative hash input excludes `entryHash` and `writerSignature`, which are
added after hashing.

Canonicalize the unsigned event with RFC 8785 JSON Canonicalization Scheme, then
calculate:

```text
entryHash = SHA-256(
  "dtsf-baby-ledger-entry-v1" || 0x00 || canonicalUnsignedEvent
)
```

The domain separator prevents a ledger entry hash from being confused with another
kind of hash used by the system.

After hashing, the isolated ledger-writer service signs `entryHash` with its per-run
Ed25519 key and stores:

```json
{
  "entryHash": "sha256:...",
  "writerSignature": "ed25519:..."
}
```

The first event uses a documented all-zero `previousEntryHash`. Every later event
must reference the immediately preceding entry hash.

## 5. Event Types

At minimum, support:

- `term.first_emitted`;
- `term.first_received`;
- `hypothesis.created`;
- `hypothesis.revised`;
- `hypothesis.contradicted`;
- `hypothesis.abandoned`;
- `construction.created`;
- `construction.revised`;
- `intention.recorded`;
- `interpretation.recorded`;
- `affect.recorded`;
- `policy.checkpointed`;
- `run.sealed`.

Event types do not change the append-only rule. A revision appends a new event that
references the prior hypothesis; it never overwrites the earlier event.

## 6. Binding Ledgers to Communication

The evidence system maintains three independent hash chains:

- Baby A ledger;
- Baby B ledger;
- channel transcript.

Every accepted public message contains or references:

- sender ledger sequence and entry hash;
- channel sequence and previous channel hash;
- hash of the exact delivered public artifact;
- gateway validation result;
- receiver-delivery receipt.

The sender submits the public artifact and required private ledger mutation as one
turn proposal. The gateway validates the proposal, commits the private event and
channel event atomically, then releases only the public artifact.

The receiver's interpretation event later references the delivered channel-event
hash. This creates a verifiable graph from intention to message to interpretation to
outcome without exposing one Baby's private ledger to the other.

## 7. Ordered Merkle Checkpoints

Use an RFC 6962-style ordered Merkle tree for each log.

Leaf hashes should bind both sequence and entry hash:

```text
leafHash = SHA-256(
  "dtsf-merkle-leaf-v1" || 0x00 || uint64(sequence) || entryHash
)
```

Internal nodes use a separate domain:

```text
nodeHash = SHA-256(
  "dtsf-merkle-node-v1" || 0x01 || leftChildHash || rightChildHash
)
```

The checkpoint stores each tree's root and leaf count. Tree size is essential because
the same root without a size does not fully describe the committed prefix.

The verifier must support:

- entry inclusion proofs;
- prefix consistency proofs between checkpoints;
- full rebuild from disclosed JSONL evidence.

## 8. Checkpoint Manifest

Illustrative manifest:

```json
{
  "version": 1,
  "runIdHash": "sha256:...",
  "checkpointSequence": 7,
  "previousCheckpointHash": "sha256:...",
  "babyA": {
    "treeSize": 128,
    "merkleRoot": "sha256:...",
    "lastEntryHash": "sha256:..."
  },
  "babyB": {
    "treeSize": 124,
    "merkleRoot": "sha256:...",
    "lastEntryHash": "sha256:..."
  },
  "channel": {
    "treeSize": 96,
    "merkleRoot": "sha256:...",
    "lastEntryHash": "sha256:..."
  },
  "runConfigurationHash": "sha256:...",
  "promptBundleHash": "sha256:...",
  "softwareCommit": "git:<commit>",
  "createdAt": "2026-08-24T21:35:00.000Z",
  "witnessKeyId": "nursery-witness-v1"
}
```

Canonicalize and hash the unsigned manifest:

```text
checkpointHash = SHA-256(
  "dtsf-ledger-checkpoint-v1" || 0x00 || canonicalUnsignedManifest
)
```

The Nursery witness signs the checkpoint hash with Ed25519. The previous checkpoint
hash makes the checkpoint series itself append-only.

## 9. Checkpoint Frequency

Create a checkpoint:

- at run initialization;
- every 64 accepted ledger events or five minutes, whichever occurs first;
- immediately before and after a policy checkpoint;
- after a BabySitter or human intervention;
- when the run is paused;
- when the run ends or is aborted.

The exact frequency is a protocol parameter recorded before the run. A lower interval
reduces the unanchored rewrite window but increases anchoring cost.

## 10. Base and L1 Anchoring

### Development

Use Base Sepolia to test transaction construction, failure recovery, receipt capture,
and verification without spending mainnet funds.

### Public Research Runs

Use Base mainnet for routine checkpoint anchoring. Only the 32-byte checkpoint hash
and minimal routing metadata should be public.

The simplest viable anchor is a zero-value transaction from the project anchor wallet
to a designated project address with the checkpoint hash in transaction calldata.
The evidence bundle records:

- chain ID;
- transaction hash;
- sender and destination;
- input data;
- block number and block hash;
- transaction status;
- confirmation or finality policy;
- RPC endpoint used for verification.

A minimal anchor contract that emits a typed event can replace the self-transaction
after the prototype. The event should include:

```solidity
event CheckpointAnchored(
    bytes32 indexed runIdHash,
    uint64 indexed checkpointSequence,
    bytes32 checkpointHash
);
```

The contract must not receive ledger content, prompts, messages, model outputs,
identities, or secrets.

### Optional Ethereum L1 Checkpoint

Periodically combine final Base-anchored run checkpoints into a project-level Merkle
root and anchor that root to Ethereum L1. For example:

- after every public study batch;
- daily during an active study;
- before publishing a paper or dataset release.

Base anchoring is sufficient for the initial implementation. L1 anchoring is an
additional trust and archival choice, not a prerequisite for every turn.

## 11. Key Management

Use separate keys for:

- Baby A ledger writer;
- Baby B ledger writer;
- channel transcript writer;
- Nursery checkpoint witness;
- on-chain anchor wallet.

Generate per-run ledger-writer keys inside their isolated services. Record public keys
in the run manifest. Never expose signing keys to model context or tools.

The anchor wallet should be a dedicated low-balance wallet with no other authority.
Production anchoring should use a managed signer or hardware-backed key. The verifier
requires only public keys and chain data.

## 12. Privacy

Only checkpoint hashes are written on-chain.

The `blindingNonce` in each event reduces dictionary attacks against low-entropy
private content when entry commitments or inclusion proofs are shared. Nonces remain
inside the protected evidence bundle until content is intentionally disclosed.

Public reports can reveal:

- checkpoint manifests;
- selected entries and their inclusion proofs;
- redacted JSONL exports;
- verification reports.

They need not reveal all private ledger content.

## 13. Evidence Bundle

Each sealed run should produce:

```text
evidence/
  runs/
    <run-id>/
      run-manifest.json
      baby-a-ledger.jsonl
      baby-b-ledger.jsonl
      channel-transcript.jsonl
      checkpoints/
        000001.json
        000002.json
      proofs/
        inclusion/
        consistency/
      anchors/
        base-receipts.json
        l1-receipts.json
      policies/
      prompts/
      configuration/
      verification-report.json
```

The final checkpoint commits the run manifest, prompt bundle, configuration, policy
artifacts, and final log roots.

## 14. Independent Verification

A standalone verifier should:

1. validate canonical JSON;
2. verify run ID, Baby ID, and strictly increasing sequence numbers;
3. rebuild every entry hash;
4. verify every previous-entry link;
5. verify ledger-writer signatures;
6. rebuild ordered Merkle roots;
7. verify inclusion and consistency proofs;
8. rebuild each checkpoint hash;
9. verify Nursery witness signatures;
10. retrieve anchoring transactions from an independent RPC provider;
11. confirm chain ID, calldata or event fields, receipt status, and block inclusion;
12. report gaps, forks, invalid signatures, unanchored tails, and final verified sizes.

The verifier should exit nonzero on any integrity failure and produce a machine-readable
report suitable for CI and research evidence.

## 15. Recovery and Fork Handling

After restart or restore:

- load the last valid entry and checkpoint hashes;
- verify the committed prefix before accepting new writes;
- continue with the next sequence number;
- never truncate or reuse a sequence number;
- create an explicit recovery event.

If two entries claim the same Baby and sequence with different hashes, the ledger is
forked. Preserve both artifacts, stop the run, and mark the evidence invalid until a
research-integrity review is complete.

An aborted run should still receive a `run.sealed` event, final checkpoint, and anchor.
Failure evidence is part of the research record.

## 16. Implementation Phases

### Phase 0: Local Integrity

- SQLite append-only event tables;
- RFC 8785 canonical JSON;
- SHA-256 hash chains;
- Ed25519 writer signatures;
- JSONL evidence export;
- standalone verifier.

### Phase 1: Merkle Proofs

- ordered Merkle roots;
- inclusion proofs;
- checkpoint consistency proofs;
- signed checkpoint manifests.

### Phase 2: Testnet Anchoring

- Base Sepolia publisher;
- receipt capture;
- independent RPC verification;
- retry and nonce management;
- deliberate failure tests.

### Phase 3: Public Anchoring

- Base mainnet anchor wallet;
- published anchor address or minimal contract;
- finality policy;
- optional Ethereum L1 batch root;
- public verification instructions.

## 17. Acceptance Tests

The integrity implementation is not complete until automated tests prove that the
verifier rejects:

- modified event content;
- changed sequence number;
- deleted middle entry;
- inserted entry;
- reordered entries;
- incorrect previous-entry hash;
- invalid writer signature;
- incorrect Merkle root;
- false inclusion proof;
- inconsistent checkpoint prefix;
- modified run configuration;
- anchor transaction on the wrong chain;
- failed or nonexistent anchor transaction;
- unanchored final ledger tail.

It must accept an unchanged run bundle and independently reproduce the final anchored
checkpoint hash.

## 18. Recommended Initial Decision

Implement Phase 0 and Phase 1 first. Add Base Sepolia anchoring immediately after the
local verifier is stable. Move to Base mainnet only for declared public research runs.

This design is simple enough for an initial Node.js implementation using SQLite,
`node:crypto`, canonical JSON, and a small Base transaction publisher. It provides
strong tamper evidence without putting sensitive Baby ledger content on-chain.
