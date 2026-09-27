# Provenance preservation-manifest spec v1

- classification: research-supplement (not a research finding; `researchFinding: false`, `scientificDisposition: not-tested`)
- specVersion: v1
- handoff: H4 (HANDYM)
- writtenAgainst: `feat/verifiable-core @ 0eb4e84`
- companion: `reports/research/lifetime-charge-reconciliation-supplement.v1.md` (§1 source map)

## 1. Purpose and non-goals

This spec defines the hash-verified preservation copy of the pre-purge history bundle
and the manifest that must accompany it, so that OLD-hash citations in the v1 records
(inventory `sourceCommit 04ef2ca…`, deviation "measured against `04ef2ca`", detector-v3
`sourceCommit 110572a…`) remain resolvable after the 2026-09-27 history purge.

NON-GOALS (binding):

- This spec copies nothing and creates no manifest instance. The copy and the manifest
  are executed by ALDM (which owns launcher/monitor/file-ownership duties); HANDYM only
  specifies the contract here.
- No commit, push, build, or test is authorized by this spec.
- The preservation copy does not rehabilitate, re-admit, or re-cite the purged
  `plans/completion-plan.md` content; it preserves provenance resolvability only.

## 2. Source artifact (verified read-only for this spec)

| field | value |
|---|---|
| path | `/tmp/ald-pre-purge.bundle` |
| sha256 | `bdec28e9bb04d5296067c5f8332fed8529489ee8a68f58221f1f1a583f5902de` |
| bytes | `78417499` |
| verification observed | `sha256sum` match; `stat -c%s` = 78417499; `git bundle verify` → "okay", "complete history", hash algorithm sha1 |
| verified on | 2026-09-27 (H4 drafting session) |

Refs contained (`git bundle list-heads`):

| ref | hash |
|---|---|
| `refs/heads/feat/verifiable-core` | `15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc` (OLD R01 tip) |
| `HEAD` | `15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc` |
| `refs/heads/main` | `feb68708333d2a1212bc7789480fa48e999ae643` |
| `refs/remotes/origin/HEAD` | `feb68708333d2a1212bc7789480fa48e999ae643` |
| `refs/remotes/origin/main` | `feb68708333d2a1212bc7789480fa48e999ae643` |
| `refs/remotes/fork/main` | `d1b4eabcde991de06eb94e6f260a62c7d4b00f8c` |

## 3. Target

| field | value |
|---|---|
| path | `evidence/provenance/ald-pre-purge-2026-09-27.bundle` |
| directory | `evidence/provenance/` — DOES NOT EXIST at spec time; ALDM creates it as part of the copy |
| manifest path | `evidence/provenance/ald-pre-purge-2026-09-27.manifest.json` (ALDM writes; schema §4) |
| content | byte-identical copy of the source artifact |

## 4. Manifest schema (ALDM writes the instance)

The manifest is a JSON object with these REQUIRED fields (no optional silent defaults):

```json
{
  "schemaVersion": 1,
  "classification": "provenance-preservation-manifest",
  "researchFinding": false,
  "manifestVersion": "v1",
  "source": {
    "path": "/tmp/ald-pre-purge.bundle",
    "sha256": "sha256:bdec28e9bb04d5296067c5f8332fed8529489ee8a68f58221f1f1a583f5902de",
    "bytes": 78417499,
    "bundleRefs": {
      "refs/heads/feat/verifiable-core": "15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc",
      "HEAD": "15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc",
      "refs/heads/main": "feb68708333d2a1212bc7789480fa48e999ae643",
      "refs/remotes/origin/HEAD": "feb68708333d2a1212bc7789480fa48e999ae643",
      "refs/remotes/origin/main": "feb68708333d2a1212bc7789480fa48e999ae643",
      "refs/remotes/fork/main": "d1b4eabcde991de06eb94e6f260a62c7d4b00f8c"
    }
  },
  "target": {
    "path": "evidence/provenance/ald-pre-purge-2026-09-27.bundle",
    "sha256": "sha256:<recomputed-after-copy>",
    "bytes": "<recomputed-after-copy>"
  },
  "verification": {
    "sha256Match": true,
    "bytesMatch": true,
    "gitBundleVerify": "okay",
    "listHeadsMatch": true,
    "tipTreeCheck": "empty diff 15d0fb3..e6d5da0 (1224 files each side)",
    "commands": ["<exact commands run, in order>"],
    "verifiedAt": "<UTC timestamp>",
    "verifiedBy": "<operator/lane>"
  },
  "storageAccounting": {
    "priorRetainedBytes": 5527700332,
    "addedBundleBytes": 78417499,
    "addedManifestBytes": "<measured>",
    "newRetainedBytes": "<recomputed by du -sb evidence/>",
    "ceilingRetainedPlusWorkingBytes": 26843545600,
    "remainingCapacity": "UNRESOLVED"
  },
  "oldToNewSourceMap": {
    "15d0fb3cf2b3c4f8aef758f0b1167e365fd4a1cc": "e6d5da0de6a79286bc32f42c89d8e7217bd29adf",
    "04ef2caa28ca12f2f628944d212f938f2c72fdbc": "fdbf29b1d1fe4807b4decc42d1c39a5df4e9573b",
    "9fe8f29c0dce8fd888b1881bb2f3a4d82675da82": "9be6e536de2f2b32ee9e4d98b492d3a8a931297e"
  },
  "claimBoundary": "Provenance preservation only. Resolves old-hash citations; establishes no scientific result and no resource headroom."
}
```

## 5. ALDM execution procedure (normative)

1. Create `evidence/provenance/` (no such dir exists; no other `evidence/` writes).
2. Copy: `cp /tmp/ald-pre-purge.bundle evidence/provenance/ald-pre-purge-2026-09-27.bundle`
   (single full-file copy; no streaming transforms, no partial writes retained on failure).
3. Recompute: `sha256sum` and `stat -c%s` on the TARGET; both must equal the §2 values.
4. Structural check: `git bundle verify` on the target (expect "okay") and
   `git bundle list-heads` on the target (expect the six §2 refs exactly).
5. Spot provenance check: empty tree diff between the OLD tip in the bundle and the
   NEW tip in the checkout for the three mapped pairs (§4 map); record the result.
6. Write the manifest instance per §4 with measured values (never copied expectations).
7. Storage accounting: re-run `du -sb evidence/` for `newRetainedBytes` (expected
   prior 5,527,700,332 + 78,417,499 + manifest bytes ≈ 5,606,117,831 + manifest).
   Record a NEW resource-balance version; do not edit `research-resource-balance.v1.json`.
8. Failure handling: on ANY mismatch, delete the target file, record the failure, and
   re-copy from source. Never leave a partial or mismatched bundle beside a manifest
   claiming success. If `/tmp` source is unavailable, stop and record unavailability —
   do not substitute another bundle.

## 6. Storage accounting (spec-time projection)

- Prior retained (measured v1, re-verified by `du -sb` this session): 5,527,700,332 B.
- Added by this preservation: 78,417,499 B (bundle) + manifest bytes (small, measured
  at write time). Projected retained ≈ 5,606,117,831 B + manifest.
- Ceiling: 26,843,545,600 B retained+working. Headroom against retained alone is NOT
  remaining capacity: CPU-hours and working peaks remain UNRESOLVED (companion §4),
  so `remainingCapacity` stays UNRESOLVED after the copy.
- The preservation copy is the first deliberate second root outside the original
  `evidence/` measurement; the v1 "included-in-retained / no separate roots" note is
  superseded for the copy by the new balance version, not edited in place.

## 7. Acceptance criteria

- Target file exists, byte-identical to source (sha256 + byte count match §2).
- `git bundle verify` on target reports okay; six refs match §2 exactly.
- Manifest instance exists at §3 path, validates against §4 (all required fields,
  measured — not transcribed — target hash/bytes, exact commands recorded).
- New resource-balance version records the added bytes; v1 files untouched.
- Gate unchanged: collection stays BLOCKED per the companion supplement §6.
