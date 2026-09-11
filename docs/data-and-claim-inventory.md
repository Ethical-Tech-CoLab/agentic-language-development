# Data and Claim Inventory

Status: A01 evidence-cutoff inventory complete; no research result

The machine-readable source is
`reports/research/data-claim-manifest.json`. It captures every exported run bundle
present under local ignored evidence storage on 2026-09-11 without copying raw events,
messages, observations, native ledgers, or secrets into Git.

## Inventory result

The snapshot contains 111 bundles in 16 collections and 219,742,662 bundle bytes.
Every bundle has a recorded verifier exit code of zero. That fact does not make every
collection current or scientific: 33 are historical qualification exports whose old
intervention-tree declaration is incompatible with the current verifier, 42 belong
to failed or superseded diagnostic collections, and 36 have tracked bounded software
qualification support. All 111 are excluded from empirical estimates.

Sixty-three bundle reports record anchor confirmation, but every such confirmation
in this snapshot is a local fake-chain qualification receipt. Confirmed public-chain
anchors: zero. The manifest uses separate fields for these values and its audit fails
if any local receipt is relabeled public.

| Evidence use | Bundles | Permitted claim |
|---|---:|---|
| Exact/current bounded software qualification | 36 | Only the claim boundary in the matching tracked receipt |
| Historical qualification | 33 | Historical software behavior; no inheritance of current verifier status |
| Failed or superseded diagnostic | 42 | Failure history and debugging provenance only |
| Pilot | 0 | None |
| Confirmatory | 0 | None |
| Replication | 0 | None |
| Empirical research estimate | 0 | None |

Every bundle entry records its path, run/experiment identifiers, deployment and
software metadata, manifest and verification-report hashes, complete relative-path
content commitment, file/byte counts, verification basis, explicit exclusion, and
allowed claim use. Collection entries link exact qualification groups to their
tracked receipts. Diagnostics remain visible even when their bundle-level verifier
reported success, because a green bundle cannot erase a failed or superseded
collection-level purpose.

## Reproduction

`pnpm run audit:data-claims` validates the tracked manifest without requiring the
ignored evidence corpus, so clean checkouts and CI can enforce claim boundaries.
`pnpm run audit:data-claims:live` additionally re-hashes every locally captured file
and fails if the evidence snapshot differs. `pnpm run build:data-claim-manifest` is an
intentional snapshot update and must be accompanied by a review of every new
collection's evidence class and inclusion rule.

Any future pilot, confirmatory, or replication run reopens A01. It must use its
prospective D07 seed domain and receive an explicit inclusion decision; mere presence,
a verifier pass, or an anchor receipt never promotes it automatically.
