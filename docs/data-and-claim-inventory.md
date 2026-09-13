# Data and Claim Inventory

Status: A01 evidence-cutoff inventory complete; no research result

The machine-readable source is
`reports/research/data-claim-manifest.json`. It captures every exported run bundle
present under local ignored evidence storage at the v0.1.104 cutoff on 2026-09-13 without copying raw events,
messages, observations, native ledgers, or secrets into Git.

This frozen inventory predates registered E02 collection. The running attempt is
tracked separately until its evidence and disposition can be reconciled. New
exports can make the live whole-tree comparison report a stale snapshot; the
portable check continues to validate the frozen cutoff, not newly collected data.

## Inventory result

The snapshot contains 138 bundles in 22 collections and 257,875,782 bundle bytes.
Of 138 exports, 137 have a recorded verifier exit code of zero; one partial
unregistered development export has no recorded verification report. A pass does
not make a collection current or scientific: 33 are historical qualification exports
whose old intervention-tree declaration is incompatible with the current verifier,
59 belong to development, failed, or superseded diagnostics, and 46 have tracked bounded software
qualification support. All 138 are excluded from empirical estimates.

Ninety bundle records show anchor confirmation, but every such confirmation
in this snapshot is a local simulated receipt. Confirmed public-chain
anchors: zero. The manifest uses separate fields for these values and its audit fails
if any local receipt is relabeled public.

| Evidence use | Bundles | Permitted claim |
|---|---:|---|
| Exact/current bounded software qualification | 46 | Only the claim boundary in the matching tracked receipt |
| Historical qualification | 33 | Historical software behavior; no inheritance of current verifier status |
| Development, failed, or superseded diagnostic | 59 | Development behavior, failure history, and debugging provenance only |
| Pilot | 0 | None |
| Confirmatory | 0 | None |
| Replication | 0 | None |
| Empirical research estimate | 0 | None |

Every bundle entry records its path, run/experiment identifiers, deployment and
software metadata, manifest and optional verification-report hashes, complete relative-path
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
