# Simulation-Funded Research Profile

Status: approved prospective project profile  
Decision: `ALD-GOV-2026-09-12-01`  
Machine-readable policy: `protocols/research-governance-and-funding.v1.json`

The research campaign uses no real currency, token, faucet allocation, paid RPC,
or public-chain transaction. It executes real software and records real observed
outputs over synthetic scenarios, but it uses a deterministic in-memory chain and
non-monetary test units for the anchoring path.

## What may be simulated

- account balance, fee, block, confirmation-depth, and transaction identifiers;
- scenario inputs, agent observations, communication artifacts, and fault cases;
- chain outages, reverts, retry behavior, wrong-chain receipts, and tampering.

Every such value is labeled simulation evidence. The deterministic transport must
produce its identifiers from committed inputs, and the verifier must recompute the
evidence bindings and reject the registered mutations.

## What may not be invented

Outcome observations, effect sizes, uncertainty intervals, p-values, timing,
resource use, failure rates, and verifier dispositions must come from actual
executions. Missing executions remain missing data. Simulated funds do not permit
fabricated scientific results.

## Integrity and registration

External prospective registration remains required for confirmatory work. Before
collection, the canonical registration hash is committed through the deterministic
simulation transport and recorded with `anchorClass: "simulated"`. This proves that
the run consumed the registered bytes and makes later changes detectable within the
evidence bundle. It does not provide public timestamping, decentralized persistence,
economic finality, or third-party chain availability. The external registration
timestamp and immutable Git commit provide the independent time/order evidence.

Public-chain support remains an optional software capability and may be tested with
mocks. It is outside the approved research profile. Activating it requires a new
prospective amendment with an explicit nonzero spending and custody decision.

## Data and retention boundary

The approved scope is synthetic data only, with no human participants, personal
data, production secrets, or human-coded outcomes. Eligible research evidence is
retained indefinitely. Development bulk payloads may be purged after 30 days while
metadata, manifests, receipts, and audit logs remain. Any later human-data or
human-coding proposal requires a new decision before collection.
