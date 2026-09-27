# Reproducible artifact outline (skeleton)

Status: **outline only**. The artifact is complete when one entry point
reproduces every table in `estimates-and-intervals.md` from sealed inputs on
a clean checkout, witnessed by the R10 reproduction receipt.

## B1. Source and analysis identity

| Item | Value |
|---|---|
| Source commit (exact SHA) | `TBD` — frozen at R08 lock |
| Analysis command(s) and IDs | `TBD` (R05 contracts) |
| Model/config IDs | `TBD` |
| Environment manifest | `reports/research/environment-manifest.json` + `TBD` freeze delta |
| Clean-source-closure check | `TBD` command + receipt |

No rebuild or change of the live execution source during reproduction. The
reproduction runs the frozen source, not a patched copy.

## B2. One reproduction entry point

```sh
# TBD — single command, e.g.:
# TBD-reproduce --manifest <sealed-manifest> --out <results-dir>
```

Contract (from R05 happy path plus missing/corrupt/stale/failure/null paths):

- Happy path: exit 0 with all tables regenerated and digests matching §B3.
- Missing input: named error, nonzero exit, no partial table presented as
  complete.
- Corrupt input (digest mismatch): named error, nonzero exit, no fallback to
  unsealed data.
- Stale input (superseded manifest): named error directing to the current
  manifest.
- Null/empty result set: valid empty output with explicit empty-set marker,
  never a silent zero or a success inferred from file presence.
- No success based on file presence or bare booleans anywhere in the chain.

## B3. Exact input digests — shell

| Input | Path or locator | SHA-256 |
|---|---|---|
| Sealed main-stage manifest | `TBD` | TBD |
| Sealed repeat-stage manifest | `TBD` | TBD |
| Registered design packet (R03) | `TBD` | TBD |
| Registered analysis packet | `TBD` | TBD |
| Environment manifest freeze delta | `TBD` | TBD |

## B4. Verification steps (reviewer script)

1. `TBD`: verify clean checkout at the §B1 source commit.
2. `TBD`: verify every §B3 digest against the sealed inputs.
3. `TBD`: run the §B2 entry point; confirm exit 0.
4. `TBD`: confirm regenerated tables match the manuscript's tables byte for
   byte (or by stated digest comparison).
5. `TBD`: confirm the R10 reproduction receipt references this exact run.

## B5. Retention and size notes

- Supplementary TMLR uploads are limited to 100 MB; retain full original
  evidence separately with the locator recorded here: `TBD`.
- Sealed inputs stay immutable; the artifact never writes into evidence
  directories.
