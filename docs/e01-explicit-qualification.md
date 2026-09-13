# E01 explicit isolation qualification

This procedure closes the explicit-corpus and signed-evidence gap left by v1.
It is software qualification using local synthetic tasks and simulated anchors,
not an agent-language result or independent public timestamp. Historical v1
packets and observations remain unchanged.

## Corpus and decision

Each of five freshly recreated two-learner container topologies records:

| Record group | Records per slot | Required observation |
| --- | ---: | --- |
| Explicit prohibited content, silence, retries | 20 | Gateway rejection with no recipient delivery |
| Filesystem, cache, vector store, replay, snapshot | 10 | Both roles deny each path; clipboard/process/worker access denied, environment empty, direct peer connection refused |
| Accepted and malformed transport calls | 80 | Captured raw 8 KiB frames; identical generic malformed-error bodies; absolute condition-mean timing difference at most 100 ms |
| Allowed delivery control | 1 | Real receiver interpretation bound to the accepted channel event |
| Planted detector fixtures | 1 | Host exposure, timing, size, error-shape and hidden-state-correlation detectors identify the deliberately leaky fixtures |

The 112 records are individually witness-signed. Every attachment is bound by an
intervention event with an inclusion proof in the final signed checkpoint. The
checkpoint receives a hash-only simulated anchor. Both the TypeScript verifier and
the separately implemented Rust auditor must accept the complete bundle.

The Nursery sees actual success and error responses. It is not the other learner.
Their bodies are not claimed identical across success and failure; error bodies
are compared across malformed inputs. Raw captured frames are retained so their
decoded bodies and byte counts can be recomputed. A refused filesystem operation
does not count as permission denial. Storage tests exercise the named denied
paths; they do not claim to test a deployed external vector database or cache.
Planted fixtures qualify detectors and are not observations of real escapes.

## Prospective execution

Use the repository's pinned pnpm toolchain. Development runs use separate ignored
directories and can never be promoted into qualification outcomes.

1. Validate and commit implementation with a patch bump.
2. Run `node scripts/register-e01-v2.mjs --compile`; commit the exact packet with
   the next patch bump. The packet binds the complete runtime source set, explicit
   corpus, fresh scenario seeds, decision margins and exclusion rules.
3. Run `node scripts/register-e01-v2.mjs --activate`; commit its simulated pre-run
   binding with the next patch bump. `--check` reproduces the full binding.
4. On the clean execution commit, build the Rust auditor with
   `CARGO_TARGET_DIR=.artifacts/cargo-target cargo build --locked --release --manifest-path tools/integrity-auditor/Cargo.toml`,
   then run `node scripts/run-e01-v2.mjs` once. The runner refuses overwrite and
   changed registered sources. A measured failure fails its slot; infrastructure
   failure stops execution and retains available logs and evidence. No seed rerun.
5. Run `node scripts/run-e01-v2.mjs --audit` against retained original evidence.
   Reconcile every notebook criterion before changing E01's status.

`node scripts/check-e01-v2-mutations.mjs <development-slot-directory>` checks altered
temporary copies, including a missing per-attempt proof, and preserves the source.
Portable corpus regression tests are under `scripts/__tests__/`.

## Limits

Signatures prove consistency of retained bytes under the recorded keys, not that
the operator is independent or incapable of fabricating observations. Simulated
anchors use no real funds and do not provide public consensus or an independent
timestamp. Passing this finite corpus supports only its tested topology and
threat model, not universal resistance to side channels or behavioral emergence.
