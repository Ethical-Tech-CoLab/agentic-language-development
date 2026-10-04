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
   the suite finish and confirm merge unblocks.
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
curl -s https://api.github.com/repos/Ethical-Tech-CoLab/agentic-language-development/rulesets
```

`protected: true` (or a non-empty ruleset requiring both checks) plus a PR
whose merge is blocked while a check fails is the complete ALD-078 blocking
proof. Until then, ALD-078's blocking half stays open no matter how green
local runs are.
