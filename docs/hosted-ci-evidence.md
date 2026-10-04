# Hosted CI evidence

The first complete hosted execution of the consolidated workflow ran against
commit `5f22202f01fe425d91c8862f91d1f62a9cf19070` on 2026-09-09:

- run: <https://github.com/SHi-ON/agentic-language-development/actions/runs/34405045176>
- `consolidated-suite`: passed in 2m08s and uploaded JUnit plus runtime evidence;
- `mode-r`: passed in 1m34s and uploaded real-container runtime evidence; and
- the consolidated suite included all 20 randomized SIGKILL crash points in
  `packages/evidence/__tests__/crash-safety.test.ts`, with no torn-write
  failure.

The upstream pull-request execution is separately visible at
<https://github.com/Ethical-Tech-CoLab/agentic-language-development/actions/runs/34404969953>.
It is `action_required`, not failed: an upstream maintainer must approve the
first workflow run from this fork. This receipt therefore proves hosted suite
execution and ALD-011 crash safety, but does not claim that upstream branch
protection or its required-check policy is active.

A newer privacy-minimized read-only observation is recorded in
`reports/research/upstream-enforcement-observation.json`. As of 2026-09-11 it found
zero repository rulesets and no demonstrated branch protection. The exact v0.1.78
candidate is now the head of the existing upstream pull request, but its workflow is
`action_required` and started zero jobs; the latest relevant default-branch workflow
also failed. The local workflow still defines both required job IDs. O04 therefore
remains open until the proposed-change workflow is approved, both checks pass, and an
authorized administrator requires them before merge.

A second read-only observation followed on 2026-10-04, recorded in
`reports/research/upstream-enforcement-observation-2026-10-04.json`. Upstream PR #1
has since closed unmerged and PR #2 is open at
`847cdb2de2b391bb2e225010404830ce2ddef030` (v0.1.529); its workflow run
([37176138263](https://github.com/Ethical-Tech-CoLab/agentic-language-development/actions/runs/37176138263))
is again `action_required` with zero jobs started. Both upstream and fork `main`
branches now report `protected: false` on the public branch endpoint with zero
rulesets, so merge-blocking is affirmatively not configured on either repository.
The exact admin sequence to enable it (approve the PR run first so the
`consolidated-suite` and `mode-r` check names exist, then require them on `main`,
then demonstrate blocking) is documented in
`docs/required-check-enforcement.md`.

The trigger half fired again the same night: pushing `a90728a` to the PR
branch produced upstream run
([37178076830](https://github.com/Ethical-Tech-CoLab/agentic-language-development/actions/runs/37178076830)),
`action_required` with zero jobs started — every proposed change reaches CI,
and execution still awaits the maintainer approval that step 1 of the
runbook requires.
