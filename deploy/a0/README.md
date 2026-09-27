# A0 shared-host containment (repo-side artifacts)

Status: IMPLEMENTATION DRAFT — scripts + slice committed, NOT installed,
NOT qualified. A0 stays HOST_BLOCKED until install + qualification below pass.

## What this is

- `aldresearch.slice`: the project-specific aggregate boundary (user manager).
  Caps: 1 CPU-equivalent, 1536M high / 2G max RAM, no swap, 128 tasks.
- `scripts/a0-preflight.mjs`: dependency-free admission check (60s window).
  Reads MemAvailable, slice charge, CPU/steal/load, PSI, filesystem free
  space, and oom_kill deltas. Exit 0 admit / 1 block / 2 error.
- `scripts/a0-lease.mjs`: single-lease registry (`create|show|release`).
  Requires a fresh (<10 min) admitting preflight receipt; refuses a second
  concurrent lease; prints the exact `systemd-run` leaf invocation.

Job leaves are transient scopes with pinned properties (Nice=15, idle I/O,
768M high / 1G max, 64 tasks, 10s stop). Leads/agents stay observational
(H7 accounting) — the harness cannot move existing sessions into the slice,
and preexisting PIDs are never claimed as contained.

## Install (user terminal — writes outside the agent sandbox)

```sh
mkdir -p ~/.config/systemd/user
cp deploy/a0/aldresearch.slice ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start aldresearch.slice
systemctl --user show aldresearch.slice -p Slice,MemoryHigh,MemoryMax,CPUQuotaPerSecUSec,TasksMax
```

Verify the read-back matches the file. Never touch production units,
`user.slice` itself, or the pre-existing failed `ald-e02-qualification-v2`
unit (left as found).

## Qualify (admitted session, after install)

1. Preflight dry run: `node scripts/a0-preflight.mjs --write .artifacts/a0-leases/preflight-1.json`.
   Expect `block` with `declared workload does not fit` while uncapped
   residents exceed the high watermark — that is the limiter working.
2. Tiny-leaf checks (each inside the slice via a lease): rejection on a
   deliberately tiny `MemoryMax=16M` leaf; worker inheritance (`sleep` child
   visible under the leaf scope); two-lease exclusion (second `create`
   refuses); missing-preflight refusal; release + re-create cycle.
3. Record the qualification receipt (commands, outputs, effective settings)
   and only then mark A0 verified in the plans.

## Known limits (do not work around)

- `io` is not delegated to the user slice (`cpu memory pids` only), so
  `IOWeight`/`io.max` are unverifiable: **disk-heavy work stays blocked**.
- Kernel OOM journal is unreadable by this user; recovery relies on
  `memory.events` oom_kill deltas at root/user-slice/research-slice scopes
  against `.artifacts/a0-leases/oom-baseline.json`. First run has no
  baseline and says so.
- Leads, tool hosts, and idle agents are charged observationally; if their
  peaks plus the job's 1.5x allowance exceed the high watermark, admission
  fails. That is correct behavior, not a tuning prompt.
