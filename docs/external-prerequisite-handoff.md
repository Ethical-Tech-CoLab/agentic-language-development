# External Prerequisite Handoff

Status: one of four applicable prerequisites verified; two public-chain items are not applicable
Machine-readable ledger: `reports/research/external-prerequisite-readiness.json`  
Audit command: `pnpm run audit:external-prerequisites`

This handoff turns O01–O06 into evidence checks that an authorized operator or
reviewer can complete without exposing credentials or implying that repository work
can manufacture approval. A receipt is necessary but not sufficient: its contents
must be authentic, complete, independently checked where required, and accepted by
the campaign and experiment-specific preflight gates.

## Current disposition

| Item | State | Decisive closure evidence |
|---|---|---|
| O01 governance | Verified | `ALD-GOV-2026-09-12-01` approves synthetic-only data, role assignments, retention, no human coding, and the simulation-only funding boundary |
| O02 Sepolia authority | Not applicable | External spend is zero and public-chain transactions are prohibited; deterministic simulated commitment replaces the campaign dependency |
| O03 mainnet authority | Not applicable | Mainnet remains an optional inactive capability that would require a new prospective amendment |
| O04 upstream enforcement | Observed unsatisfied | Exact candidate upstream, required `consolidated-suite` and `mode-r` checks, enforced protection/ruleset, fresh passing hosted receipts |
| O05 independent restore | Missing | A second human completes the authoritative restore runbook with checksums and every policy/prefix result |
| O06 external registration | Missing | Zero-field-gap packet, external registration, identical hash, and independently verified matching pre-run simulated commitment |

The earlier Fort runtime receipt remains valid software and secret-boundary evidence,
but its unfunded public wallet is no longer a campaign dependency. The approved
profile uses no faucet, token, fee, or public transaction. The deterministic
transport must label every receipt `simulated`; relabeling that field causes verifier
failure.

The 2026-09-11 read-only O04 observation found no repository ruleset and could not
demonstrate branch protection. The exact v0.1.78 candidate is published as the head of
the existing upstream pull request, but its proposed-change workflow completed as
`action_required` before starting any job. The latest relevant default-branch
workflow also failed. The observation is stored in
`reports/research/upstream-enforcement-observation.json`.

## Evidence sequence

1. Preserve O01's approved scope. Any human data, human coding, personal data,
   sensitive data, real currency, or public-chain proposal requires a new prospective
   amendment before collection.
2. Treat O02 and O03 as non-applicable while the simulation-only decision remains in
   force. Do not fund the existing address or submit a public transaction.
4. Complete O04 through authorized upstream administration, then repeat a read-only
   audit against the exact execution commit. A locally green run does not establish
   merge protection.
5. Complete O05 using `docs/snapshot-restore-runbook.md`. The reviewer must be a
   human other than the implementer; an internal or AI-assisted replay is not
   independent evidence.
6. Complete D08's operational bindings and blinded-pilot selection before O06.
   Register the exact compiled packet externally and commit the identical hash through
   the deterministic transport before the first eligible outcome. Never register a
   packet retrospectively.

## Secret-safe execution boundary

Research-grade signer material is materialized only in files mode:

```sh
si fort run --repo agentic-language-development --env dev \
  --keys ALD_RUN_SIGNER_SEEDS_JSON --mode files -- \
  pnpm run test:mode-r-study
```

This command demonstrates the signer boundary only when the encrypted environment
has been provisioned for the exact run IDs. It does not submit a public transaction
or authorize an outcome claim. Never echo, print, copy, or commit materialized secret
files.

## Activation check

After an authentic receipt is added, update only the corresponding ledger item,
bind the receipt SHA-256, and run:

```sh
pnpm run audit:external-prerequisites
pnpm run audit:campaign-readiness
pnpm run audit:registration-readiness
```

For an experiment with a complete compiled packet and external binding, run the
existing fail-closed preflight with those exact files:

```sh
pnpm run preflight:research -- \
  --registration path/to/compiled-registration.json \
  --binding path/to/external-binding.json
```

Only a `READY` result for the exact immutable candidate removes that experiment's
configuration-and-binding preflight block. It does not replace governance,
scientific dependency, resource, final-topology, or independent-review gates.
