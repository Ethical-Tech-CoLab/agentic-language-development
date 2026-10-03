# LV01 row-extraction mapping v1.1 (compatible clarification to v1)

Tracked mirror of `plans/drafts/lv01-row-extraction-mapping-v1.1.md`
(2026-10-03), committed for git visibility because `plans/` is ignored.
Canonical working copy remains `plans/drafts/`; read together with the
v1 mirror. Single-turn behavior identical under v1 and v1.1.

Correction 2026-10-03 (operator-caught, mirrors `plans/drafts/`): the
original C3(b) falsely stated the builder asserts no cross-partition
uniqueness. It DOES (`lv01-schedule.ts:127-131`, both stateHash and
caseId). C3(b) WITHDRAWN; C3(a) stands, narrowed to malformed
caller-supplied schedules.

## C1. Per-episode-turn intention matching (refines v1 Q1 "turn-0")

The intention record is matched at `event.turn === turn.turn` per episode
turn — not literal turn 0. Single-turn bundles match the turn-0 precedent
exactly; multi-episode parent bundles extract one record per turn, each
turn carrying its own intention + outcome agreement (v1 Q1 rule applies
per turn, unchanged).

## C2. Join key is scenarioStateHash (refines v1 Q1/Q3 "caseId join")

Evidence turns carry `scenarioStateHash`, not `caseId`, so the join runs
scenario-hash → scheduled case. Equivalent to the v1 caseId join GIVEN
cross-partition stateHash uniqueness (a schedule design property:
committed schedule, unique cases). The loader additionally rejects
duplicate scenario hashes within the ordinary partitions (fail closed).

## C3. Recommendation (non-blocking hardening)

Narrow the C2 trust assumption (loader end): (a) loader-side explicit
test-partition membership pre-check — reject any turn whose hash appears
in a within-support-test case with a distinct test-episode error (today
such turns fail as "unlisted", which is correct but conflated); (b)
builder-side assertion: WITHDRAWN 2026-10-03 — already asserted (`lv01-schedule.ts:127-131`); guards malformed supplied schedules only.

## Evidence index

`lv01-ordinary-loader.ts:58-73,:45-51,:61-66`; schedule header.
Determined from committed bytes eefb80c, read in tree 2026-10-03.
