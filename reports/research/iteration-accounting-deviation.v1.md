# Iteration-accounting deviation record v1

Handoff: R01 step 3. Status: append-only; new entries append below, never edit history.
Source commit: measured against `04ef2ca` (entries cite their own measurement commit).

## Entry 1 — 2026-09-27: lifetime compliance unresolved, collection blocked

- Lifetime policy: five development iterations (LV01 v1 seed/resource policy).
- Observed: 22 retained `evidence/lv01/development-v2..v23` directories plus
  detector/paired/fault families; all 23
  `protocols/lv01-development-resource-allocation.v*.json` allocations declare
  `smallFixture.iteration = 1`, and
  `scripts/check-lv01-development-allocation.mjs` requires exactly that value.
  v23 (`lv01-development-v23-p0001`, net 10.250.185.x/28) therefore passes the
  checker while lifetime compliance is unestablished.
- No per-attempt lifetime classification exists (development iteration vs dyad vs
  control/fault fixture vs preflight failure). No retrospective exemption,
  renaming, or version reset is permitted to reconcile the counter, and the v2
  amendment does not reset history.
- Resource side (see `research-resource-balance.v1.json`): retained bytes measured
  (evidence/ 5,527,700,332 B); cumulative CPU-hours and working/staging peaks are
  unresolved (sampled spots only, no cumulative cgroup records); live reserved
  cost is zero after the v3 teardown. Remaining capacity: UNRESOLVED.
- Decision: new experimental collection stays BLOCKED until (a) every attempt has
  an explicit lifetime classification within a stated allowance, and (b) remaining
  CPU/storage/memory capacity is explicit. Both require a prospective
  authorization this record does not invent. R02–R05 preparation proceeds;
  R06 is the first lawful new-collection launcher.
