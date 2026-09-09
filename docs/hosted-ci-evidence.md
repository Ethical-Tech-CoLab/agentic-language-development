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
