# Shared-host safety review (H7) — HANDYM

Status: HOST_BLOCKED (policy rev 1 defined; ALDM containment TODO; ALDM policy ACK pending).
Scope: `agentic-language-development` only. Parent: `0eb4e84`. No builds, runs, or production changes for this note.

## Host snapshot (2026-09-27 ~20:46 UTC, read-only)

- 6 logical CPUs; 7.5 GiB RAM; no swap; load 0.16 / 0.41 / 2.72.
- MemAvailable ~3.3 GiB; memory PSI avg10 0.00/0.00; I/O PSI full avg10 0.00. Healthy at this instant; not a reservation.
- Biggest residents: two Muse leads (~1.1 GiB + ~1.0 GiB RSS), codex app-server (~357 MiB), third muse (~282 MiB). Production: dockerd, traefik, next-server, postgres, cloudflared, fort, containerd — never capped/reniced/restarted for research.

## Accounting vs the 2 GiB host cap

- In-scope research residents alone (≈2.1 GiB for the two leads, before children/tool hosts) already exceed the `MemoryMax=2G` aggregate cap. Containment unverified, so the uncapped charge counts in full: admission check 1 fails → HOST_BLOCKED stands.
- The historic 6 GiB campaign ceiling is a separate, looser constraint. The 2 GiB host cap wins. Never treat campaign headroom as host permission.
- The two Sept-27 Muse OOM victims (PIDs 2501507, 3278000) are agent-process incidents, not evidence that any registered dyad failed. No study failure inferred.

## Child/concurrency reconciliation

- HANDYM has 3 read-only verification children running (R04.1/R04.2/R05.1), launched before rev 2. This exceeds the new 1-child global cap; grandfathered, not extended.
- Commitment: no new children, builds, suites, installs, numerical batches, or collection until the 3 drain AND A0 is admitted with a fresh ALDM host lease. Lead-only doc edits continue.

## What unblocks A0 (ALDM owns, HANDYM audits)

1. Scoped `aldresearch.slice` + leaf limits effective for fresh processes; no production mutation.
2. Preflight + monitor proving rejection, inheritance, two-lease exclusion, partial-cost capture, scoped stop, recovery — on tiny disposable fixtures, never by stressing production.
3. ALDM policy ACK with active PIDs/children and containment checkpoint.
4. Reconciled OOM incident + 5 min healthy readings + full admission pass per task.

## Calibration guardrail

When A0 passes, the five R06 calibration dyads must run under the admitted constrained profile (nice 15, 1-CPU quota, I/O idle, 1 worker/thread) with measured throttled wall time recorded. Slower low-priority execution never extends a frozen deadline or shrinks N.
