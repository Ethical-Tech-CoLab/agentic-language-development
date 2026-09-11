# Configuration

Runtime configuration is loaded through `@ald/config`. Environment variables contain
only non-secret operational values or short-lived file paths materialized by `si fort`.
Private key material, signer seeds, RPC credentials, and API tokens must never be
stored directly in environment variables or repository files.

## Variables

| Variable | Type | Default | Required |
|---|---|---|---|
| `DTSF_PORT` | Positive integer | `8080` | No |
| `DTSF_TWIN_PACKS_DIR` | Path | `./twins/packs` | No |
| `ALD_DEPLOYMENT_MODE` | `prototype` or `research-grade` | `prototype` | No |
| `ALD_EVIDENCE_DIR` | Path | `./evidence` | No |
| `ALD_DATABASE_PATH` | Path | `<evidence>/ald.sqlite` | No |
| `ALD_RUN_SIGNER_SEEDS_JSON_FILE` | Fort-materialized path | None | Yes in research-grade mode |
| `ALD_LOG_LEVEL` | `debug`, `info`, `warn`, or `error` | `info` | No |
| `ALD_BASE_NETWORK` | `base-sepolia` or `base-mainnet` | `base-sepolia` | No |
| `ALD_BASE_RPC_URL_FILE` | Fort-materialized path | None | Required only when anchoring is enabled |
| `ALD_ANCHOR_KEY_FILE` | Fort-materialized path | None | Required only when anchoring is enabled |
| `ALD_ALLOW_MAINNET_ANCHORING` | `true` or unset | unset | Must be `true` (together with an explicit publisher opt-in) before any Base mainnet transaction is submitted |

## Secret Handling

- Store all secret values only in the encrypted `safe` repository and access them
  through `si fort`; do not create ad-hoc secret files.
- Do not commit `.env` files. The repository ignores `.env` and `.env.*`.
- Use a dedicated, low-balance anchor wallet.
- Run `pnpm run scan:secrets` before committing.
- Research-grade mode fails fast unless Fort materializes
  `ALD_RUN_SIGNER_SEEDS_JSON_FILE` in files mode.
- Mainnet anchoring is double opt-in: the anchor publisher must be constructed with `allowMainnet: true` and `ALD_ALLOW_MAINNET_ANCHORING=true` must be set; the default anchors to Base Sepolia only.
- The signer material is a versioned JSON envelope containing an exact run-id map
  and all six Ed25519 signer domains. The Nursery reads its mode-0600 regular file
  once; the path is then removed from the child environment. Learner containers
  never receive the path or file mount. Seeds never enter the evidence store or a
  bundle.

## Examples

Prototype defaults require no environment variables:

```powershell
pnpm run build
```

Research-grade Mode R uses Fort file materialization:

```sh
si fort run --repo agentic-language-development --env dev \
  --keys ALD_RUN_SIGNER_SEEDS_JSON --mode files -- \
  pnpm run test:mode-r-study
```

The encrypted value must authorize each exact study run id. The qualification
command can run without credentials using ephemeral in-memory signers, but that
path is explicitly non-confirmatory and cannot satisfy a public-study gate.
