# Public-Chain Anchor Staging (ALD-020 / ALD-022)

Manual runbook for submitting checkpoint digests to Base Sepolia (ALD-020)
and staging the mainnet opt-in path (ALD-022) with
`scripts/anchor-public-submit.mjs`. All research campaign runs stay on
`anchorClass: "simulated"`; public-chain operation is outside the approved
research profile and needs a prospective governance amendment per
`SPECIFICATION.md` §13.4 before any production use.

## Prerequisites

- `pnpm install --frozen-lockfile && pnpm run build`
- A Base RPC endpoint per network, each stored as one URL on a single line in
  its own file (for example `~/.ald/sepolia-rpc.url`). Only the host label is
  ever recorded; userinfo, path, and query credentials never reach output.
- A dedicated, low-balance anchor wallet key file per network (see below).
  Mainnet additionally requires a managed signer or hardware-backed key per
  SPEC §19 ADR-02 — a file key is a staging-only stand-in, never production
  custody.
- For Sepolia: testnet ETH on the wallet from a Base Sepolia faucet. One
  zero-value anchor costs well under 0.001 test ETH.
- For mainnet: explicit user approval in chat before any broadcast. No
  exceptions, including staging.

Generate a wallet (mode 0600, refuses to overwrite; prints `{ "keyFile", "address" }` JSON):

```sh
node scripts/anchor-public-submit.mjs --generate-key --key-file ~/.ald/sepolia-anchor.key
```

## ALD-020: Base Sepolia submission

1. Dry-run (read-only; broadcasts nothing):

```sh
node scripts/anchor-public-submit.mjs --dry-run --network base-sepolia \
  --rpc-url-file ~/.ald/sepolia-rpc.url \
  --from 0x<wallet address> --to 0x<project address> \
  --checkpoint-hash sha256:<64 hex> \
  --out /tmp/ald020-dryrun.json
```

A `--checkpoint-manifest <path>` may replace `--checkpoint-hash`; the
manifest `checkpointHash` is then bound into the evidence.

2. Broadcast, wait for 1 confirmation, verify calldata, write the receipt:

```sh
node scripts/anchor-public-submit.mjs --broadcast --network base-sepolia \
  --rpc-url-file ~/.ald/sepolia-rpc.url \
  --key-file ~/.ald/sepolia-anchor.key \
  --to 0x<project address> \
  --checkpoint-hash sha256:<64 hex> \
  --out reports/research/ald-020-sepolia-anchor-receipt.json
```

3. Verify on the public explorer at the printed
`https://sepolia.basescan.org/tx/<hash>` URL:
   - status success, chain 84532 (Base Sepolia);
   - `from` is the anchor wallet, `to` is the project address;
   - input data is exactly `0x<checkpoint digest>`, 66 characters, nothing else.
4. Link the receipt and explorer URL in `BACKLOG.md` ALD-020 and the
conformance matrix, then check the box.

Receipt shape can be checked dry (no network) before the live run:

```sh
node -e "import('./scripts/anchor-faucet-watch.mjs').then(m => console.log(JSON.stringify(m.readAndAssertReceipt(process.argv[1]))))" /tmp/ald020-receipt.json
```

It refuses wrong networks, wrong chain ids, and explorer URLs that merely
contain (rather than start with) `https://sepolia.basescan.org/tx/0x`.

If a broadcast run is interrupted after printing the transaction hash, check
the explorer before re-running: a fresh process signs at a fresh nonce and
would pay for a second transaction for the same checkpoint.

## ALD-022: mainnet staging (no broadcast without approval)

Default-off is enforced twice: `BaseAnchorPublisher` throws
`MainnetAnchoringDisabledError` before any RPC call unless constructed with
`allowMainnet: true` AND `ALD_ALLOW_MAINNET_ANCHORING=true`, and the staging
script applies the same rule to every mainnet invocation, including dry-runs.
Covered by `packages/anchor/__tests__/publisher.test.ts`
(mainnet policy switch) and `scripts/__tests__/anchor-staging.test.ts`.

Staging dry-run (read-only; the farthest this path goes without approval):

```sh
ALD_ALLOW_MAINNET_ANCHORING=true node scripts/anchor-public-submit.mjs --dry-run \
  --network base-mainnet --allow-mainnet \
  --rpc-url-file ~/.ald/mainnet-rpc.url \
  --from 0x<wallet address> --to 0x<project address> \
  --checkpoint-hash sha256:<64 hex> \
  --out /tmp/ald022-dryrun.json
```

Without both opt-ins the command refuses with exit 2 (gate error
`MAINNET_ANCHORING_DISABLED`; only the human-readable message is printed)
and makes zero mainnet RPC calls.

Mainnet broadcast additionally requires `--confirm-mainnet-broadcast`, which
must be passed only after explicit user approval in chat, and then waits for
the `safe-tag` depth (192 Base blocks) before reporting anchored-final:

```sh
ALD_ALLOW_MAINNET_ANCHORING=true node scripts/anchor-public-submit.mjs --broadcast \
  --network base-mainnet --allow-mainnet --confirm-mainnet-broadcast \
  --rpc-url-file ~/.ald/mainnet-rpc.url \
  --key-file ~/.ald/mainnet-anchor.key \
  --to 0x<project address> \
  --checkpoint-hash sha256:<64 hex> \
  --out reports/research/ald-022-mainnet-anchor-receipt.json
```

Status: staging-ready. ALD-022 criterion 2 stays open until an approved
staging broadcast produces a mainnet receipt.

## Faucet-watch resume (R2-C, ALD-020)

`scripts/anchor-faucet-watch.mjs` is the one-command resume path: it checks
the anchor wallet balance and, only when funded, broadcasts, verifies the
Sepolia receipt, checks the ALD-020 box, syncs BACKLOG/README/RESEARCH counts,
regenerates the conformance matrix, verifies gates, and commits the named
files. Push is opt-in (`--push`, only with push authorization).

```sh
node scripts/anchor-faucet-watch.mjs \
  --rpc-url-file ~/.ald/sepolia-rpc.url \
  --key-file ~/.ald/sepolia-anchor.key \
  --to 0x<project address> \
  --checkpoint-hash sha256:<64 hex> \
  --receipt-out reports/research/ald-020-sepolia-anchor-receipt.json
```

Safety shape (not configurable): no `--network` input exists; the RPC chain
id must be exactly 84532; the receipt must report `base-sepolia`; a zero
balance is never funded. Mainnet is unreachable through this script.
`--check-only` reports the funding decision without broadcasting.
`--watch --interval-seconds <n> --max-checks <n>` repeats the check bounded;
each funded check broadcasts at most once (receipt files are never
overwritten, and re-running after a close-out refuses the checked box).

Not funded yet: the command prints `NOT_FUNDED` with balance, required total
(estimate x 2 margin), and address, then exits 0. Fund the printed address
from a Base Sepolia faucet and re-run; nothing else changes until funds land.

## Troubleshooting

- `RPC chain id ... does not match`: the RPC file points at the wrong network.
- Empty balance on Sepolia: fund the printed wallet address from a faucet
  and re-run the dry-run.
- `eth_estimateGas` failure: the node rejected the estimate call (not a
  funding problem) — check the RPC endpoint and the `from`/`to` addresses,
  then re-run.
- Key file permission errors: the loader requires mode 0600 and a
  group/other-writable-free parent directory (`chmod 600` the file,
  `chmod go-w` the directory); the generator already creates both correctly.
- `Refusing to overwrite`: evidence files are write-once; choose a new
  `--out` path instead of replacing a receipt.
