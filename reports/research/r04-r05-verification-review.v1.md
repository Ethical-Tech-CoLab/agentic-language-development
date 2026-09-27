# R04.1 / R04.2 / R05.1 verification review (HANDYM → ALDM)

Three read-only verifiers, zero writes/builds/runs, baseline `0eb4e84` (dirty tree noted). All 3 drained 2026-09-27 with structured findings; full transcripts in session log. This note consolidates. Verdicts below are review input, not independent-human replication. Greenness of any suite is unverified (no execution slot) — every "N tests green" claim needs an admitted rerun.

## R04.1 pre-action vectors (`6f2648c` + `8f7814b`) — mechanics sound, proof partly synthetic

Confirmed: native formula equals the frozen plan (1e-12 weights, 4-candidate normalize, latest-association-per-token, uniform on missing/disabled); v1 digest byte-identical; commit-before-action pinned deterministically (StepClock, not wall); no future-label inputs at signature level; determinism primitives (RFC-8785 canonical JSON, fixed 2000-step softmax, isolated replay, lowest-index argmax); unit-level forgery rejection (permuted native, reordered candidates, moved cutoff, swapped replay, tampered fit, unauthenticated records); frozen constants match v2 (4049 params, 565-coeff softmax, Brier 1e-12 ties, majority refit); ordinary-scorer refactor preserves pre-R04.1 semantics branch-by-branch.

Findings:
- HIGH (fixed at HEAD by `8c9323c`, keep as history): at `6f2648c` branches mapped their OWN child ledgers, and the `8f7814b` proof seeded one synthetic all-zero record — committed native vector was uniform-over-synthetic labeled `source=training-ledger`. Do not cite the `8f7814b` proof as parent-ledger evidence; cite post-`8c9323c` behavior.
- MED: ordinary-vector audit is circular (verifier rebuilds from payload-embedded fit; nothing binds it to the validation-selected refit). MED: verifier never cross-checks ledger heads, scenario hash, policy hash, schedule digest, or association provenance (A6 gap). MED: cutoff training-only held by update gating, not construction (structurally fixed only by `8c9323c` parent-sealed-prefix mapping). MED: replay/ordinary legs proven shape-only (length-4/uniform); no child-vs-parent-final-policy replay equality; no real fit, null-delivery, or tabular fail-closed runtime coverage.
- LOW: "12+ tests" = 7 new test cases (~35 asserts), no enumerating receipt; cutoff `<=` vs "strictly before" spec-text divergence (likely benign); id/fit-kind mismatch scores silently as fit; exact float `===` risks cross-machine ulp rejects; `localeCompare` ordering not locale-independent.

## R04.2 interventions (`355a1b6`) — unit mechanism genuine, live wiring defeats it

Confirmed: selection matches the registered rule (inventory-order scan, strict->, lowest-index ties, 32-token/target checks); per-role derangement with no-fixed-point gate, deterministic SeededPrng chain, fail-closed <2 cases/role, commitment binds seed+cases, slice/verify round-trip incl. distinct-target shuffle; coincidence preservation exactly as designed; gateway substitution fail-closed (`Lv01LedgerTreatmentRequiredError`, ordinary pass-through); post-`355a1b6` PRNG diff purely additive (reproducibility intact).

Findings:
- HIGH (live wiring, A4 open): `lv01-collector.ts` builds a 2-case batch sharing ONE peeked target, so both selections are deterministically identical and ledger-shuffled always delivers the consistent token — contrast exactly zero, seeded draw vacuous. Builder enforces only caseId uniqueness (no distinct-content guard). Unit tests use distinct targets, so the mechanism is genuine; the failure is live wiring. (My interim collector review independently reaches the same A4 verdict.)
- MED: one nativeIndex per two-role batch + role-filtered indexing = silent cross-role scoring; the both-role test bakes it in (baby-a index for baby-b cases). MED: derangement seed is opaque string + concat role vs registered NUL-joined full derivation (no purpose/role/partition/case/branch, no collision check). MED: auditor never re-derives the maximizing selection from the frozen ledger — self-consistent wrong-token batches pass (R04 item-6 gap shared with R04.5).
- LOW: pairing link unverified (shuffled token vs named source token, source existence, bijectivity); live `verifyLv01TreatmentTargets` call tautological (peek-built served list); branch-vs-treatment key mismatch not rejected (defense-in-depth); "50 tests" = 40 `it()`s in touched files, wider-suite implication unverified, no dedicated receipt.

## R05.1 CLI foundation (`6afef25` + `5e667c9`) — crypto/plumbing sound, admission gates open

Confirmed: packet/binding crypto chain (domain-separated canonical hashes, recompute-on-verify, tamper/cross-packet/mismatch refusal); slot plans match frozen v2 (dev 5, qual 25, pilot 20+0; main refuses explicitly); check-design v2 constants match live files by direct read; immutability + ordering (wx/0600, anti-rewrite, clean-tree preconditions, allowlists, decoupled gates, arg forwarding); honest failure verdicts (reasons + not-tested + exit 1, no fixture leakage). Note: as-committed collect failed unconditionally post-admit; HEAD already supersedes via requireAdmission + collect script.

Findings (gates A1/A2/A9 open — these are the R05.1 headline):
- HIGH ×5, all in admit/compile path: (1) source closure is proxies (tracked-only status + merge-base ancestor; untracked ignored, descendant code changes accepted; no tree hash/dependency binding); (2) resourcesSufficient is a status-string proxy (no charged balance, lifetime allowance, ceiling arithmetic); (3) topology evidence is `passed:true`+sha proxy (2-field stub reaches `ready`, v1-shaped stub admits v2 chain); (4) numerical qualification is v1-only (6-comp/36) gating v2 chains that need 7-comp/4-member/42; (5) admit checks zero A0 host state (no lease/controls/headroom).
- MED: admit/bind never re-verify packet-bound design/analysis/seed hashes vs live files ("re-verifies everything live" claim falsified — post-compile design text edits pass); no CLI-vs-packet stage/version cross-check (receipt content can disagree with its path); blocked verdicts burn the version immutably (`wx`, no retry/supersede path); check-design validates 3 of 5 required v2 files with spot asserts, not strict schemas; chain-test `ready` path currently skipped (dirty tree) with schema-less stubs proving plumbing, not frozen-value conformance.
- LOW: main-stage lock check dead code; "9 unit + 6 CLI" = 4 unit cases in added file (6 CLI confirmed); qual-v1 compile path dead (no freshQualificationSeeds); gate receipt has no self-commitment; bind invariant lives only in script wrapper, not API; unit POLICY hand-mirrors frozen values (drift-invisible); v2 draft-status files treated as verified design ("frozen v2" overstates).

## What this means for gates and credits

- Component DONE credits for R04.1/R04.2/R05.1 stand as component delivery; integrated acceptance stays IN_PROGRESS. No finding promotes or demotes a whole R row by itself.
- A1 (admission): OPEN — five HIGH findings; exact-source, resource, topology, and A0-state proxies all need hardening per handoff §6.1/§6.5.
- A2 (design validation): OPEN — 3-of-5 files, no strict schemas.
- A4 (paired treatment): OPEN — live same-target swap; needs distinct-case schedule + derangement re-verification (also my interim review §A4).
- A9 (numerics): OPEN — v1-only checker gating v2 chains.
- Test-count log lines need appended corrections after an admitted rerun: R04.1 "12+" → 7 cases; R04.2 "50" → 40 in-file `it()`s; R05.1 "9 unit" → 4 cases. Original lines preserved; corrections appended, never overwritten.
- Unresolved (all need execution slots or targeted reads): rerun all reported-green suites at commit + HEAD; live multi-case both-role schedule verification; end-to-end ledger-branch delivery proof; cross-environment float identity; `policies/<role>-latest.json` final-weights provenance; blocked-receipt retry-burn end-to-end; qual-v1 compile failure confirmation.

## Suggested ALDM order (advisory; ALDM sequences)

1. R05.2b-ii freeze with A3/A4/A5 addressed (distinct-case schedule, both roles, per-role ledgers, registered seed derivation, Prototype full-profile path — not production transport).
2. A1/A2/A9 hardening in the same freeze (exact closure, live hash re-verification, strict 5-file schemas, v2 numerical gate, A0-state check).
3. A7 zero-resource/peak-RSS fix (5-line change, high signal).
4. Admitted rerun of the three suites + appended test-count corrections.
5. Re-request HANDYM review at the frozen checkpoint; I re-verify read-only.
