# LV01 row-extraction mapping v1 (HANDYM methods answers to ALDM questionnaire)

Tracked mirror of `plans/drafts/lv01-row-extraction-mapping.v1.md` (v1 frozen
2026-10-01), committed for git visibility because `plans/` is ignored.
Canonical working copy remains `plans/drafts/`; a v2 supersedes both together.

Status: normative methods mapping (2026-10-01). Packet + code convergent on all
five questions; no blocking gap; loader unblocked. Two soft clarifications
recommended for R03-freeze hardening (non-blocking, §6).

## Q1. Which raw records count as ordinary-fit episodes? caseId rule?

An ordinary-fit episode is ONE executed scheduled case in partition
{training, validation-fit, validation-selection} (schedule partitions,
`lv01-schedule.ts:25-30`), producing exactly one `Lv01OrdinaryRecord`
("one decision/episode", study-design evaluation). Test-partition rows are
never ordinary (partitioner rejects them).

Raw records per episode (both required, must agree):

- the executed case's turn-0 `intention.recorded` ledger event
  (`content.symbols` delivery + `content.selection`), and
- the turn outcome's `details.selectedRef`.

Agreement rule (audit-loader precedent, `lv01-audit-loader.ts:196-200`):
outcome selection MUST equal intention selection, else extraction fails
(fail closed, block — never reconcile silently).

`caseId` rule: `scheduleCaseId(partition, receiverRole, caseIndex)` =
`partition:role:NNNN` (`lv01-schedule.ts:53-55`). Executed cases are verified
as a subset of the committed schedule (schedule header); caseIds unique
within a fit (`ledger-value.ts:87`); folds mutually disjoint
(`ledger-value.ts:172-175`).

On the "ledger events" forbidden item (analysis-plan `:45`): it forbids
ledger CONTENT (hypothesis/association sequences that power the native
predictor, `:20-22`) as ordinary-fit input — not the delivery/action facts
themselves, which are observable only via the intention event. Any absolute
reading would make transcript-only/task-history/softmax unimplementable and
the packet self-contradictory. One-line packet clarification recommended (§6).

## Q2. deliveredToken source? Null allowed? Inventory binding?

- Source: turn-0 `intention.recorded` `content.symbols[0] ?? null`
  (`lv01-audit-loader.ts:190-195`).
- Null: permitted ONLY when delivery is genuinely absent (no/empty symbols
  array), recorded as null, never imputed. Fits key null as `'<disabled>'`
  (`ledger-value.ts:98,144`). (The branch-gated "null only on disabled"
  rule, `:195`, governs test bundles; same fail-closed posture applies.)
- Inventory: frozen 32 distinct tokens, enforced
  (`ledger-value.ts:65-73`); out-of-inventory fails closed.
- GAP (soft, R03 hardening): the 32-token inventory is code-only
  (`TOKENS=32`); no packet pin found. Amendment should pin it (§6).

## Q3. candidateTypeCodes source? Selected-index source?

- `candidateTypeCodes`: from the SCHEDULED CASE
  (`Lv01ScheduledCase.candidateTypeCodes`, `lv01-schedule.ts:40`), not from
  evidence. Must be 4 distinct integers 0-15 (`ledger-value.ts:80`).
- `actualSelectedCandidateIndex`: index of the AGREED `selectedRef`
  (intention == outcome, Q1) within the scheduled case's ordered
  `candidateRefs` (`:41`); absent → extraction failure, fail closed.
- ALDM's boundary note is refined (not confirmed): raw evidence ALONE cannot
  supply codes — the extractor MUST join evidence rows to schedule cases by
  `caseId` (exactly what the 52f95bd partitioner assumes). With the join,
  all fields are determined.
- `targetTypeCode` (scheduled, `:39`) is researcher-only: NEVER a record
  field (records have exactly 5 keys, `ledger-value.ts:74-78`;
  target/action separation, analysis-plan `:17-18`).

## Q4. Fold-count binding? Empty-fold disposition?

- Binding: `ordinaryRecordWindow` per-role counts 1500/120/120
  (analysis-plan `:39-41`) × 2 roles = 3000/240/240 totals, drawn from
  schedule partitions training / validation-fit / validation-selection.
  Counts bind to SCHEDULE MEMBERSHIP (52f95bd partitioner), not to raw
  evidence volume; test/unlisted/duplicate caseIds fail closed.
- Empty fold: FAIL CLOSED — code refuses empty rows (`ledger-value.ts:85`).
  Never fit on empty, never silently drop a fold. (Packet silent; code
  posture stands; one-line packet note recommended, §6.)

## Q5. Receiver-role split?

PER-ROLE folds (pooling forbidden by construction): packet counts are
`…PerReceiverRole` (`:39-41`); code enforces single-role fits
(`ledger-value.ts:84-88`) and each predictor carries its `receiverRole`
(`:36-40`). Each role gets its own 1500/120/120 → own selection → own refit.

## §6. Recommended packet clarifications (non-blocking)

1. `ordinaryRecordWindow`: append "Delivery/action facts observed via
   `intention.recorded` + outcome agreement are the ordinary record's own
   fields, not forbidden ledger content."
2. Pin the 32-token delivered-token inventory (design source + exact list).
3. `ordinaryRecordWindow`: append "Empty folds fail closed; no silent drop."

## Evidence index

Analysis-plan `:17-51`; study-design partitions + `:91`;
`ledger-value.ts` `:13-20,:49-53,:65-89,:144-151,:153-185`;
`lv01-schedule.ts` `:25-55`; `lv01-audit-loader.ts` `:180-200`;
52f95bd partitioner diff. All cited bodies read in tree 2026-10-01.
No mapping invented; loader proceeds on this file.
