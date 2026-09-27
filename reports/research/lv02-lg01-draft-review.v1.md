# LV02 / LG01 draft review (R12/R13 preparation, not activation) — HANDYM

Parent: `0eb4e84`. Method: lead-only read-only check of all 7 draft files against plan §6. No builds, runs, or registration. No execution credit.

## Status labels: pass

All 7 files declare draft/deferred/not-registered/not-executed status (`draft-deferred-future-not-registered-not-executed`, `draft-not-registered-not-executed`, outcome-blind seed policy). Checked files:

- `protocols/lv02-study-design.v1.json`, `lv02-analysis-plan.v1.json`, `lv02-seed-resource-policy.v1.json`, `lv02-prototype-execution-profile.v1.json`, `lv02-direction-note.v1.json`
- `protocols/lg01-study-design.v1.json`, `lg01-analysis-plan.v1.json`

## LV02 vs §6: match

Checkpoints 0/750/1500/2250/3000 with time-zero as uniform/missing-history diagnostic only. Primary LV02-T: one-checkpoint-stale minus current pre-action Brier across the 4 post-training checkpoints, equal checkpoint/role weights, margin 0.02 / alternative 0.04, dyad-level t, degenerate p=1 rule. Comparators: latest sparse, one-stale, equal-content unsigned (predictions must match), periodic full snapshots at 64-episode cadence plus five cutoffs; final-ledger-on-early-checkpoints labeled retrospective-diagnostic-only. 240 fresh balanced probes per checkpoint, excluded from training, commit-before-first-probe-action, no learning during probes. Dedicated 20-dyad pilot, same six candidate Ns, generalized selector m=k=1. Fresh seed root `ald-ledger-value-lv02-v1` with NUL-separated `deriveSeedHex`. Progression gate requires valid LV01 R09 machinery, not a favorable LV-U. Same 4,049-param GRU, same 12 eligible types, untouched diagonal.

## LG01 vs §6: match

Factored GRU actor-critic, hidden 16, autoregressive 2-token sender over the shared 32-token inventory, 8 one-hot attribute features, shared dot-product receiver head with the 16-type-row head explicitly forbidden. Parameter contract marked RECOMPUTE, never 4,049. Optimizer/PPO retained; factored inductive bias disclosed. Latin-diagonal held-out with k=(primary_index−1) mod 4, reserves inheriting the replaced slot's stratum, held-out access ban during fitting/selection. 3,000 training episodes; 240/240/240/240 fit/selection/seen-test/unseen-test with role/target balance. Primary LG-G: conjunction of all four normal-minus-control unseen differences, 0.05/0.10, max-p member rule. 20-dyad pilot, m=1/k=4 generalized selector, same candidate Ns. Holistic type-code/two-token control at matched episodes, descriptive only. Secondaries: mask-pos-1, mask-pos-2, reverse, uniform replacement, training-only associations, unordered-code order boundary.

## Prospective corrections at activation (not now)

1. Stage labels: LV02 seed policy and LG01 prose use main/repeat. At activation use canonical confirmatory/replication per coordination §5.3, same correction as R03-B. Drafts stay as-is until then.
2. LG01 reuses the LV01 v2 execution profile. The draft already notes LG01-specific qualification is still required before any collection; verify that qualification exists at activation, do not inherit it silently.
3. LV02 direction-note activation checklist must be checked against actual R09 evidence then; nothing in these drafts pre-clears it.
