# External Prerequisite Handoff

Status: one of one applicable prerequisites verified; five external enhancements are not applicable to local execution
Machine-readable ledger: `reports/research/external-prerequisite-readiness.json`  
Audit command: `pnpm run audit:external-prerequisites`

This handoff turns O01–O06 into evidence checks that an authorized operator or
reviewer can audit without exposing credentials or confusing optional external
enhancements with experiment requirements. This ledger does not replace the local
canonical-packet, prospective-commitment, or experiment-specific preflight gates.

## Current disposition

| Item | State | Decisive closure evidence |
|---|---|---|
| O01 governance | Verified | `ALD-GOV-2026-09-12-01` approves synthetic-only data, role assignments, retention, no human coding, and the simulation-only funding boundary |
| O02 Sepolia authority | Not applicable | External spend is zero and public-chain transactions are prohibited; deterministic simulated commitment replaces the campaign dependency |
| O03 mainnet authority | Not applicable | Mainnet remains an optional inactive capability that would require a new prospective amendment |
| O04 upstream enforcement | Not applicable | Exact-commit clean-tree local validation governs collection; hosted enforcement is optional release governance |
| O05 independent restore | Not applicable | First-party restore verification remains mandatory; second-person execution is optional independent-reproducibility evidence |
| O06 external registration | Not applicable | Repository-native registration replaces the activation dependency; third-party registration remains optional |

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
`reports/research/upstream-enforcement-observation.json`. This limits hosted-
enforcement claims but no longer blocks local synthetic experiments.

## Evidence sequence

1. Preserve O01's approved scope. Any human data, human coding, personal data,
   sensitive data, real currency, or public-chain proposal requires a new prospective
   amendment before collection.
2. Treat O02 and O03 as non-applicable while the simulation-only decision remains in
   force. Do not fund the existing address or submit a public transaction.
3. Treat O04 and O05 as optional enhancements. Local checks do not establish hosted
   enforcement or independent human restoration, so never make those claims.
4. Complete D08's operational bindings and blinded-pilot selection. Commit the exact
   packet unchanged to Git, verify its bytes at an ancestral commit, and commit the
   identical hash through deterministic transport before the first eligible outcome.
   Never register a packet retrospectively.

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

After a local packet is complete, bind its repository record and run:

```sh
pnpm run audit:external-prerequisites
pnpm run audit:campaign-readiness
pnpm run audit:registration-readiness
```

For an experiment with a complete compiled packet and repository-native binding, run the
existing fail-closed preflight with those exact files:

```sh
pnpm run preflight:research -- \
  --registration path/to/compiled-registration.json \
  --binding path/to/repository-registration-and-commitment-binding.json
```

Only a `READY` result for the exact immutable candidate removes that experiment's
configuration-and-binding preflight block. It does not replace governance,
scientific dependency, resource, final-topology, or independent-review gates.
