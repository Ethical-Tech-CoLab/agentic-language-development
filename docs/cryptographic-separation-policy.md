# Cryptographic Research Separation Policy

Status: mandatory review gate for E40 software and evidence.

## Boundary

`@ald/crypto-research` implements ALD-069 research instrumentation. Its scheme
identifiers, nonce commitments, novelty registry comparisons, and eavesdropper
measurements describe experimental artifacts only. They do not provide or claim
confidentiality, integrity, authenticity, forward secrecy, key security, or
production-ready encryption.

Production evidence integrity remains exclusively the responsibility of:

- **ALD-009:** domain-separated SHA-256 event hashing and per-stream Ed25519
  signing in `@ald/hashing`;
- **ALD-019:** reviewed Base transaction signing, key handling, and anchoring in
  `@ald/anchor`.

No learned encoding, generated codebook, cipher artifact, E40 nonce, or module
from `packages/crypto-research` may be imported into `packages/hashing` or
`packages/anchor`. The repository's `lint:crypto-boundary` check enforces this
dependency direction on every full check.

## Required E40 reporting

Every E40 attachment must report these dimensions separately:

1. artifact novelty relative to the supplied prior-artifact registry;
2. recovery outcomes for each pre-registered Eve architecture;
3. cryptographic security as `not-established`.

Uniqueness, a fresh salt or nonce, and low recovery against one implemented Eve
must never change the third value. E40 uses synthetic, non-sensitive messages
only. Any future security claim requires an external threat model, formal
argument, expert review, and reviewed production implementation outside this
research harness.

## Review gate

Gate G5 / ALD-077 may mark E40 *software readiness* only when the ALD-069 tests
and the import-boundary lint pass. That readiness does not change E40's
`Not started` notebook status, satisfy its cryptographic-review checklist, or
constitute an experiment result.
