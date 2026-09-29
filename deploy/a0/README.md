# A0 shared-host containment (repo-side artifacts)

Status: HARDENED IMPLEMENTATION — preflight/lease/launcher repairs committed,
NOT qualified. Per-job execution stays unqualified until the checks below pass (no slice install exists under rev5).
Policy: `plans/research-validation-plan.md` section 6 (Resource policy revision 5, agent-managed). The revision-4 enforced profile below is a historical record: DO NOT install this template or reimpose agent caps.

## What this is

- `aldresearch.slice`: the project-specific aggregate boundary (user manager).
  Retired caps (historical only, never install): 1 CPU-equivalent, 3584M high / 4G max RAM, no swap, 128 tasks. Job scopes created at launch carry the live bounds.
- `scripts/a0-preflight.mjs`: dependency-free admission check. Observes (never
  limit-compares) effective slice values, records member nice levels as
  advisory, verifies lease-recorded residents (PID + start-time identity,
  slice membership), samples all required readings at every 5s sample of the
  60s window, checks the cap-free headroom formula, PSI, available-to-user
  storage on the job filesystem, I/O binding, read-only production health,
  and OOM recovery state.
  Exit 0 admit / 1 block / 2 error. Windows other than 60s/5s are
  diagnostic-only and can never admit.
- `scripts/a0-lease.mjs`: single-lease registry (`create|show|release`).
  Atomically acquires (hard-link: exactly one concurrent winner) and binds a
  fresh (<10 min) admitting receipt to the same policy rev, source, task,
  command, peak, data path and I/O class, plus a receipt-content hash.
  Prints the exact verified `systemd-run` leaf invocation.
- `scripts/a0-launch.mjs`: the ONLY executor of a lease. Re-verifies receipt
  hash/admission/freshness, launches the leaf from outside the aggregate
  (the kernel forbids non-leaf -> descendant migration, so a supervisor
  inside the slice cannot start a leaf beneath it — EUCLEAN, observed
  2026-09-28), reads back effective properties/membership/nice, enforces
  the deadline, samples health every 5s (deadline, emergency, graceful
  stops per policy §5), and performs owned-unit cleanup on every path.
  Exit: job code on completion, 124 on timeout, 2 on supervision failure
  or failed start (`launch-failed`, e.g. `Job failed` with no unit
  activity — never reported as a job result). No auto-restart, no broad
  kill, no second job. The supervisor's own RSS is counted once as an
  uncapped in-scope resident by the preflight via its lease member entry.

Job leaves are transient scopes with verified properties (MemoryHigh 768M,
MemoryMax 1G, TasksMax 64, TimeoutStopSec 10, CPUWeight 10, RuntimeMaxSec =
lease timeout). Leads/agents stay observational until moved by a fresh
verified launch — the harness never claims preexisting PIDs as contained,
and moving an existing session is not containment.

## Verified scope-property support (2026-09-28 disposable probes)

Transient `--scope` units ACCEPT: MemoryHigh, MemoryMax, TasksMax,
TimeoutStopSec, RuntimeMaxSec, CPUWeight (all read back effective).
They REJECT with `Unknown assignment`: Nice=, IOSchedulingClass=.

Consequences, all enforced in code, not convention:

- Nice=15 is set by the launcher on itself (`os.setPriority`, always
  permitted downward) and inherited by the leaf; the launcher verifies every leaf
  member's `/proc` nice at start and the preflight re-verifies members.
- Idle I/O class is unverifiable on scopes AND the io controller is not
  delegated (see below): the I/O class of a job is recorded as unsupported,
  and disk-heavy work stays blocked. No silent fallback is claimed.

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

## Operate

Bind one job end to end (all from the repo root):

```sh
# 1. Admit exactly this job: task, command, source, peak, path, io class.
node scripts/a0-preflight.mjs --task <task> --command '<cmd>' \
  --data-path <job-dir> --disk-heavy no --health-file <health-json> \
  --write .artifacts/a0-leases/preflight-<id>.json
# 2. Acquire the single lease (fails if another is active).
node scripts/a0-lease.mjs create --owner <you> --task <task> \
  --command '<cmd>' --preflight .artifacts/a0-leases/preflight-<id>.json \
  --timeout <sec> --source <git-sha-or-auto> --data-path <job-dir>
# 3. Launch supervised (the ONLY execution path; never run the leaf by hand).
node scripts/a0-launch.mjs --owner <you>
```

The lease refuses mismatched task/command/source/peak/path/io-class between
its flags and the receipt, stale (>10 min) or non-admitting receipts, and
disk-heavy jobs without `ioReady`. The launcher re-verifies the receipt hash
at start, so editing the receipt after acquisition refuses to launch.

## Production-health evidence (operator requirement)

Admission requires read-only proof that production is healthy. Provide a JSON
file (default max age 300s, override with `--health-max-age-sec`):

```json
{ "healthy": true, "at": "2026-09-28T12:00:00.000Z", "source": "prod-monitor" }
```

`healthy` must be `true`, `at` fresh ISO time, `source` a non-empty identity
of the existing check that produced it. No file, stale file, failing file,
or unreadable file blocks admission; the launcher re-checks the same file
every sample and emergency-stops the job if production goes unhealthy.
There is no in-repo producer for this file: until the operator binds one,
the health gate stays honestly closed. Unknown required telemetry blocks
admission; it is never assumed healthy.

## OOM recovery: baseline, history, incidents

- First run writes the baseline and blocks on `no OOM baseline`: that run
  establishes observation, it does not admit.
- Every run appends to `oom-history.jsonl` (pruned past 2h). Admission needs
  10 minutes of quiet history with no counter increases.
- A delta over the baseline opens `oom-incident.json` and blocks; the
  baseline is NOT rewritten while an incident is open, and a second probe
  never erases it. Reconcile explicitly after investigating:

```sh
node scripts/a0-preflight.mjs --reconcile-oom <id> --reason '<cause + handling>'
```

Reconciliation requires zero new kills since the incident and records who
acknowledged it and why. It is not admission: a fresh full preflight must
still pass afterwards.

Global OOM observation uses `/proc/vmstat oom_kill` (world-readable, all
slices incl. production): the root cgroup exposes no `memory.events` on
this host. The kernel OOM journal remains unreadable by this user.

## Qualify (after install)

1. Preflight dry run: `node scripts/a0-preflight.mjs --write
   .artifacts/a0-leases/preflight-1.json` (plus `--task/--command/
   --health-file` for a bound receipt). Expect `block` with concrete
   reasons while any gate is open — that is the limiter working.
2. Scoped suites (admitted run): `a0-lease` (atomicity/binding/corruption),
   `a0-preflight` (validation/diagnostic/baseline/reconcile/marker),
   `a0-launch` (trivial/timeout/failure/refusals). All skip rather than
   disturb an operator lease; lease/launch tests use synthetic receipts and
   trivial payloads, preflight tests use isolated state files.
3. Disposable control fixtures (record commands, outputs, effective
   settings; each seconds-long, never memory-exhausting):
   - trivial launch: lease + `true` via the launcher; expect completion,
     released record, unit gone, no survivors;
   - deadline: `sleep 30` with timeout 3; expect exit 124, `timeout`
     outcome, verified members/readback in the released record;
   - tiny-leaf rejection: a direct disposable 16M scope (systemd layer,
     not the lease — the launcher pins the 1G backstop and offers no
     test-only limits) running a small over-allocation; expect a
     contained OOM kill of the leaf only, then reconcile the resulting
     incident explicitly (this exercises recovery for real);
   - two-lease exclusion already covered by the concurrency test; also
     verify missing-preflight refusal and release + re-create cycle.
4. Record the qualification receipt (commands, outputs, effective settings)
   and only then mark A0 verified in the plans.

## Known limits (do not work around)

- `io` is not delegated to the user slice (`cpu memory pids` only), so
  `IOWeight`/`io.max` are unverifiable: **disk-heavy work stays blocked**.
  If io is ever delegated, leaf I/O properties need re-qualification first
  (scopes already reject `IOSchedulingClass=`).
- Kernel OOM journal is unreadable by this user; recovery relies on the
  vmstat global counter plus `memory.events` deltas at user-slice and
  research-slice scopes. First run has no baseline and says so.
- Leads, tool hosts, and idle agents are charged observationally through the
  lease members and the host `MemAvailable` they consume; out-of-slice
  in-scope processes not recorded in a lease are invisible to accounting
  (receipt says so). If peaks plus the job's 1.5x allowance exceed the high
  watermark, admission fails. That is correct behavior, not a tuning prompt.
- Sub-second jobs can exit before launch verification reads them; the
  launcher records `membersVerified: false` with an explicit note instead of
  claiming a check it did not perform. The verified path is proven by jobs
  that live past verification (see the timeout test).
- A `monitor-block.json` marker (supervision failure or cleanup survivors)
  closes admission until the operator investigates and removes the file
  explicitly. It is never auto-cleared.
