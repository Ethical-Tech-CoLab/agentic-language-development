# Required-check enforcement runbook (ALD-078)

Goal: every proposed change runs CI, and merge to `main` is blocked while any
suite fails. The workflow half is done in-repo; the blocking half is a
server-side setting that only a repository administrator can enable. This
runbook gives the exact sequence.

## Current state

- Workflow `.github/workflows/book-integrity.yml` triggers on every
  `pull_request` plus `push` to `main`, with jobs `consolidated-suite`
  (`pnpm run check:ci`) and `mode-r` (`pnpm run test:mode-r`).
- Fresh read-only evidence:
  `reports/research/upstream-enforcement-observation-2026-10-04.json`
  (upstream `main`: `protected=false`, zero rulesets; fork `main` likewise;
  upstream PR #2 open with workflow run `action_required`).
- The consolidated job IDs do not exist on upstream `main` yet (its workflow
  file is still the old paths-filtered one), and GitHub only offers checks
  that have run at least once as required checks. Order matters: run first,
  require second.

## Admin sequence (upstream repository)

Do these steps in order, as an administrator of
`Ethical-Tech-CoLab/agentic-language-development`:

1. Approve the held workflow on the open pull request (PR #2):
   open the PR → Checks → the `action_required` run → "Approve and run".
   Approve the currently-held run for the latest PR head — run IDs recorded
   in docs/hosted-ci-evidence.md lag new pushes (latest recorded run is for
   a90728a; HEAD has since moved to f288767).
   Both jobs must execute; if either fails, fix the branch and re-run until
   both are green. This registers the `consolidated-suite` and `mode-r`
   check names on the upstream repository.
2. Require the checks on `main` (classic protection):
   Settings → Branches → Add classic branch protection rule →
   branch name pattern `main` → enable "Require status checks before
   merging" → search and select `consolidated-suite` and `mode-r` →
   enable "Require branches to be up to date before merging" → Save.
   (Ruleset equivalent: Settings → Rules → Rulesets → New ruleset →
   target branches, include `main` → Require status checks to pass with
   `consolidated-suite` and `mode-r`.)
3. Prove blocking works: open or update any pull request against `main`
   (a no-op commit suffices), confirm the PR shows the two checks as
   pending/required and that merge is blocked until both pass, then let
   the suite finish and confirm merge unblocks. If upstream requires
   approval for every fork-PR run (not just first-time contributors), the
   demonstration push also lands `action_required`: approve that run first,
   then confirm pending/required → blocked → green → unblocked.
4. Record the evidence: run ID(s) from step 1, a screenshot or API capture
   showing the required checks on `main`, and the blocking demonstration
   from step 3. Append a dated paragraph to `docs/hosted-ci-evidence.md`
   and only then check the ALD-078 blocking criterion in `BACKLOG.md`.

API equivalent of step 2 (needs an admin token; never commit the token):

```sh
gh api repos/Ethical-Tech-CoLab/agentic-language-development/branches/main/protection \
  -X PUT \
  -f required_status_checks[strict]=true \
  -f required_status_checks[checks][][context]='consolidated-suite' \
  -f required_status_checks[checks][][context]='mode-r' \
  -f enforce_admins=true \
  -f required_pull_request_reviews=null \
  -f restrictions=null
```

Verification without credentials (anyone can re-run these):

```sh
curl -s https://api.github.com/repos/Ethical-Tech-CoLab/agentic-language-development/branches/main \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['protected'])"
# Rate-limit-safe fallback (prints the limit payload instead of KeyError-ing
# past 60 req/h):
curl -s https://api.github.com/repos/Ethical-Tech-CoLab/agentic-language-development/branches/main \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('protected', d))"
curl -s https://api.github.com/repos/Ethical-Tech-CoLab/agentic-language-development/rulesets
```

`protected: true` (or a non-empty ruleset requiring both checks) plus a PR
whose merge is blocked while a check fails is the complete ALD-078 blocking
proof. Until then, ALD-078's blocking half stays open no matter how green
local runs are.

## Local wiring proof (2026-10-04, ALDM, commit `03ec401`)

The "runs on every proposed change" half is verified end to end locally:

- Workflow triggers: `on: pull_request` (all PRs) plus `push` to `main`;
  jobs `consolidated-suite` and `mode-r` are the only two job IDs.
- `consolidated-suite` runs `pnpm run check:ci`, which runs the full vitest
  suite via `test:ci`; vitest includes `packages/**`, `twins/**`,
  `book/**`, and `scripts/__tests__`, so every backlog item's acceptance
  tests ride the same gate.
- The four suites ALD-078 names by ID all pass (node v24.21.0, 60/60
  tests, 29.6s):

```sh
./node_modules/.bin/vitest run \
  packages/evidence/__tests__/crash-safety.test.ts \
  packages/gateway/__tests__/conformance.test.ts \
  packages/leakage/__tests__/semantic-leakage.test.ts \
  packages/redteam/__tests__/side-channel.test.ts \
  packages/redteam/__tests__/observation-and-measurement.test.ts
```

  - ALD-011 crash-safety: 1 test, 20 randomized SIGKILL trials, no
    torn-write failure;
  - ALD-036 gateway conformance: 36 tests;
  - ALD-057 semantic-leakage battery: 8 tests;
  - ALD-067/068 red-team suites: 10 + 5 tests.

This proves the suites exist, pass, and are wired into the CI command the
workflow runs. It does not prove merge-blocking, which remains the open
admin step above.
