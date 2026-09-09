# Snapshot and restore runbook

This runbook covers the authoritative runtime snapshot in `@ald/ops`, not the
Research Console's lightweight `/session/snapshot` run-list cursor. The
evidence database remains authoritative; a snapshot restores policies and
cursors, then invokes normal integrity recovery against that same store.

## Preparation

1. Preserve the evidence SQLite file, bundle root, and snapshot directory as
   one recovery unit. Do not copy only the JSON snapshot to an empty host.
2. Record the running software commit and the configured
   `DTSF_SNAPSHOT_INTERVAL_MS` (default 300000 ms).
3. Pause external run stepping while taking a manual recovery snapshot.
4. Call `takeSnapshot(runtime, snapshotDirectory, { clock, softwareCommit })`
   through the operator service. Record its returned `path` and
   `snapshot.digest`.
5. Confirm `readSnapshotFile(path)` succeeds before declaring the snapshot
   usable.

## Restore

1. Stop the old runtime cleanly. Keep the original database and bundle root
   read-only until validation completes.
2. Start a new runtime instance over the preserved evidence database with the
   same signer access, learner contracts, scenario bundles, and bundle root.
3. Before accepting traffic, call
   `autoRestore(() => runtime, { directory: snapshotDirectory, bundleRoot })`.
4. Require `restored === true` and `ok === true`. For every run require no
   `error`, `turnMatches === true`, both `policyMatches` values true, and
   `prefix.ok === true`.
5. Inspect every `prefix.streams` entry. `prefixIntact` and `chainWalkOk` must
   both be true; any violation is an integrity fork and the runtime must stay
   quarantined.
6. Confirm recovery appended the expected recovery event and checkpoint after
   the immutable snapshot prefix. Resume traffic only after those checks.

## Failure handling

- `no-snapshot`: confirm the directory mount and configured path; do not start
  a fresh run under the missing run ID.
- `snapshot-digest-mismatch` or `snapshot-invalid`: quarantine the file and
  select a known earlier snapshot. Never edit a snapshot to make it parse.
- `recover-failed`, a policy mismatch, or a chain-walk violation: keep the
  run quarantined and preserve the database, snapshot, logs, and bundle for
  investigation. Do not truncate, rewrite, or reset the evidence store.

## Validation record

The restoring operator records the snapshot path/digest, software commit,
database checksum, start/end time, per-run `AutoRestoreResult`, and their
identity. ALD-079 remains externally evidence-gated until an operator other
than the implementer follows this runbook and attaches that completed record.
