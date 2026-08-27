# Configuration

Runtime configuration is loaded through `@ald/config`. Environment variables contain
only operational values and paths. Private key material and API tokens must never be
stored directly in environment files committed to this repository.

## Variables

| Variable | Type | Default | Required |
|---|---|---|---|
| `DTSF_PORT` | Positive integer | `8080` | No |
| `DTSF_TWIN_PACKS_DIR` | Path | `./twins/packs` | No |
| `ALD_DEPLOYMENT_MODE` | `prototype` or `research-grade` | `prototype` | No |
| `ALD_EVIDENCE_DIR` | Path | `./evidence` | No |
| `ALD_DATABASE_PATH` | Path | `<evidence>/ald.sqlite` | No |
| `ALD_KEY_DIR` | Path | `<evidence>/keys` | Yes in research-grade mode |
| `ALD_LOG_LEVEL` | `debug`, `info`, `warn`, or `error` | `info` | No |
| `ALD_BASE_NETWORK` | `base-sepolia` or `base-mainnet` | `base-sepolia` | No |
| `ALD_BASE_RPC_URL` | URL | None | Required only when anchoring is enabled |
| `ALD_ANCHOR_KEY_FILE` | Path | None | Required only when anchoring is enabled |

## Secret Handling

- Store private keys in files outside the repository and provide only their paths.
- Do not commit `.env` files. The repository ignores `.env` and `.env.*`.
- Use a dedicated, low-balance anchor wallet.
- Run `npm run scan:secrets` before committing.
- Research-grade mode fails fast unless `ALD_KEY_DIR` is explicitly configured.

## Examples

Prototype defaults require no environment variables:

```powershell
npm run build
```

Research-grade mode requires an explicit isolated key directory:

```powershell
$env:ALD_DEPLOYMENT_MODE = 'research-grade'
$env:ALD_KEY_DIR = 'C:\ald-secrets\keys'
npm run build
```
