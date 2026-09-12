# Canonical Registration Packet Readiness

Status: B11 in progress; zero experiment packets compile  
Evidence class: outcome-blind design inventory  
Machine inventory: `reports/research/registration-packet-readiness.json`

## Fail-closed packet contract

The general compiler now requires every experiment packet to bind exactly eleven
operational surfaces before it emits canonical bytes or a pre-registration hash:

1. the experiment protocol card;
2. exact run configurations for every condition;
3. raw-scale practical margins and decision rules;
4. exact analysis versions;
5. model and runtime asset identities;
6. the pilot-selected primary and reserve seed prefixes;
7. the approved execution-host manifest;
8. the exact scenario bundle and split definition;
9. exclusion and invalid-run rules;
10. stopping and resource-exhaustion rules; and
11. evidence, verifier, simulated-commitment, and optional public-chain boundary policy.

The compiler accepts no missing or extra binding key. It recursively rejects null,
undefined, empty, non-finite, and placeholder values such as `TBD`, `unknown`, or
`pending`. Each binding receives its own domain-separated canonical hash. The ordered
binding set is then canonicalized and hashed under the repository's pre-registration
domain. Any change to any bound content changes the packet hash.

The emitted claim boundary is `draft-until-externally-registered-and-pre-run-committed`.
Compilation alone cannot establish external registration, governance approval,
a completed commitment, public anchoring, or independent review.

## Current inventory

All 19 protocol cards resolve and receive stable card hashes. The remaining ten
bindings per experiment are deliberately unresolved: 190 unresolved bindings in
total. Therefore:

- registration-ready experiments: 0/19;
- compiled canonical packets: 0/19;
- pre-registration hashes emitted by this inventory: 0; and
- authentic external registration and matching simulated pre-run commitments: 0.

Existing generic scenario, analysis, seed-allocation, environment, and evidence
artifacts are inputs to future experiment-specific bindings. They are not silently
treated as final exact values. In particular, N=100 is still a resource-planning
value rather than a pilot-selected seed prefix.

## External steps after compilation

A complete packet must still receive authentic governance approval, external
registration of the identical canonical hash, independent verification of the same
pre-run simulated commitment, and independent methods review. These are recorded as external
steps, not fields that local code can declare satisfied.

## Verification

The focused compiler tests prove deterministic serialization, hash sensitivity,
fixed binding order, and rejection of missing, extra, empty, placeholder, invalid-ID,
and non-finite inputs. The generated inventory is checked during the consolidated
gate and will become stale if the 19 protocol cards or required binding set changes.
