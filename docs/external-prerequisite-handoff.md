# External Prerequisite Handoff

Status: all six external prerequisites remain unsatisfied  
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
| O01 governance | Missing | Dated scoped decision, responsible roles, retention/deletion policy, human-coding determination, authenticity check |
| O02 Sepolia authority | Provisioned, unfunded | Fort-mediated signer/RPC provisioning passes, but the recorded address has 0 wei; an independently confirmed privacy-minimized Base Sepolia transaction is still required |
| O03 mainnet authority | Missing | Explicit spending/custody/finality policy and bounded public signer authority; until then mainnet remains prohibited |
| O04 upstream enforcement | Observed unsatisfied | Exact candidate upstream, required `consolidated-suite` and `mode-r` checks, enforced protection/ruleset, fresh passing hosted receipts |
| O05 independent restore | Missing | A second human completes the authoritative restore runbook with checksums and every policy/prefix result |
| O06 external registration | Missing | Zero-field-gap packet, external registration, identical hash, and independently verified matching pre-run public anchor |

The 2026-09-12 Fort runtime receipt records an authenticated, encrypted project
scope, two endpoints that independently report Base Sepolia chain ID 84532, and a
four-track Fort-backed Mode R qualification. Both endpoints report 0 wei for the
public signer address, so O02 remains unsatisfied and no public-chain claim follows.
The receipt is stored in
`reports/research/fort-runtime-qualification-receipt.json`.

The 2026-09-11 read-only O04 observation found no repository ruleset and could not
demonstrate branch protection. The exact v0.1.78 candidate is published as the head of
the existing upstream pull request, but its proposed-change workflow completed as
`action_required` before starting any job. The latest relevant default-branch
workflow also failed. The observation is stored in
`reports/research/upstream-enforcement-observation.json`.

## Evidence sequence

1. Complete O01 before outcome collection. Store only a decision identifier, role
   labels, scope, dates, and an authenticity reference in tracked material. Keep
   personal identity and any restricted review record outside the anonymous artifact.
2. Complete O02 through `si fort`. The tracked receipt may contain chain ID, public
   address, transaction hash, block, confirmations, and provider reference. It must
   never contain a private key, signer seed, RPC credential, token, or decrypted
   value.
3. Record O03 as an explicit authorized policy before any mainnet-dependent work.
   Absence of a decision, a wallet balance, or a general instruction to continue is
   not spending authority.
4. Complete O04 through authorized upstream administration, then repeat a read-only
   audit against the exact execution commit. A locally green run does not establish
   merge protection.
5. Complete O05 using `docs/snapshot-restore-runbook.md`. The reviewer must be a
   human other than the implementer; an internal or AI-assisted replay is not
   independent evidence.
6. Complete D08's operational bindings and blinded-pilot selection before O06.
   Register the exact compiled packet externally and anchor the identical hash before
   the first eligible outcome. Never register a packet retrospectively.

## Secret-safe execution boundary

Research-grade signer material is materialized only in files mode:

```sh
si fort run --repo agentic-language-development --env dev \
  --keys ALD_RUN_SIGNER_SEEDS_JSON --mode files -- \
  pnpm run test:mode-r-study
```

This command demonstrates the signer boundary only when the encrypted environment
has been provisioned for the exact run IDs. It does not itself satisfy O02, submit a
transaction, or authorize a study. Never echo, print, copy, or commit materialized
secret files.

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
