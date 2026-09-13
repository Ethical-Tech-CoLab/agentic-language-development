# Phase-One Demonstration Guide

Purpose: provide a short technical walkthrough of the current research platform
without modifying original evidence or implying an agent-language finding.

## Before the review

Use the repository's Homebrew-managed Node and pnpm environment. Do not start E02,
provision credentials, or perform a public-chain action. Confirm the working tree and
the three presentation documents:

```bash
git status --short
sed -n '1,220p' reports/phase-one-research-update.md
sed -n '1,220p' reports/phase-one-evidence-appendix.md
```

If unrelated local changes are present, disclose them and avoid presenting a clean
candidate claim. The retained E02 receipt is expected tracked evidence, not a file to
delete or overwrite.

## Ten-minute walkthrough

1. **Set the claim boundary.** Open the phase-one update and state that the outcome is
   an implemented platform plus two bounded software qualifications. No language
   emergence result is claimed.
2. **Show the architecture.** Use the diagram in the update to explain the isolated
   roles, Gateway-only communication, Nursery control, signed evidence, checkpoints,
   export, and two verifier implementations.
3. **Show E00.** Open
   `reports/research/e00-integrity-qualification-receipt.json`. Point to the exact
   execution commit, five slots, unchanged-export acceptance, and registered mutation
   rejection cases. Label this software integrity qualification.
4. **Show E01.** Open
   `reports/research/e01-v2-qualification-receipt.json`. Explain that 560 signed
   records comprise rejection cases, transport captures, host/path decisions, an
   allowed-delivery control, and planted-detector records. Do not call all 560 attacks.
5. **Show the failed E02 attempt.** Open
   `reports/research/e02-qualification-receipt.json`. Point out `passed: false`, the
   non-null failure, and zero completed slots. Use the appendix for the retained
   465-turn accounting. State that the safety pause worked and that probe evaluation
   never occurred.
6. **Show current readiness.** Run the bounded tracked checks below. Finish with the
   next milestone: reproduce and correct the E02 timing interaction, then register a
   fresh attempt with new identifiers and seeds.

## Safe verification commands

```bash
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run lint:project-status
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:campaign-readiness
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:qualification-e00
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:qualification-e01
PATH=/home/linuxbrew/.linuxbrew/bin:$PATH pnpm run audit:manuscript-readiness
```

These checks validate tracked status and receipt summaries. They do not rerun the
historical experiments or independently reproduce their outcomes.

## Optional mutation-rejection demonstration

Prefer the retained E00 receipt's registered mutation table. If a live verifier
demonstration is needed, first copy one retained E00 bundle into a disposable
temporary directory, mutate only the copy with the existing challenge tooling, and
show the verifier rejection. Never change an original bundle, database, receipt,
registration packet, or Git history for a demonstration.

Describe the result narrowly: the verifier rejected that specified mutation. Do not
claim that integrity verification proves semantic truth, complete capture, or the
absence of every possible attack.

## Demonstration stop conditions

Stop and disclose the limitation if a required retained-evidence directory is absent,
a tracked audit fails, the working tree includes unexplained changes, or a displayed
status disagrees with a terminal receipt. Do not switch to a different seed, rerun a
failed registered attempt, weaken a verifier, or hide a failure to complete the demo.

## Sharing checklist

- The report date and evidence cutoff are visible.
- No personal name appears in new presentation prose.
- No secret, token, wallet material, private prompt, or raw learner ledger is shown.
- Every displayed result states its evidence class and limitation.
- Replay is labeled replay; simulation is labeled simulation; qualification is not
  labeled research.
- Screenshots, if later created, contain no private filesystem paths or misleading
  green indicators.
- Nothing is published, deployed, or sent as part of this guide.
