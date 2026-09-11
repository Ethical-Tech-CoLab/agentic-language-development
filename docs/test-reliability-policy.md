# CI and test reliability policy

Every pull request and every push to `main` runs the consolidated integrity
workflow. The required checks are the `consolidated-suite` job and the real
Docker `mode-r` job; repository branch protection must require both job names.
The first job runs a blocking high/critical dependency audit, all lints,
readiness and acceptance-coverage checks, the TypeScript build, all Vitest
tests, and the secret scanner. Its retained artifacts include the complete pnpm
audit JSON alongside the JUnit and runtime reports. The project explicitly
approves only the pinned `better-sqlite3`, `esbuild`, and source-pinned
`read-as-book` lifecycle builds; new or upgraded lifecycle scripts require
review before installation. The Mode R job
runs the separate-container isolation and training suite. The 20 randomized
SIGKILL crash points in `packages/evidence/__tests__/crash-safety.test.ts` are
therefore part of every proposed-change gate.

Both jobs upload `/usr/bin/time -v` output for each run. The consolidated job
also uploads JUnit output from Vitest. Artifacts are retained for 30 days so
runtime regressions and recurring failures can be compared between runs.

Tests are never retried or silently ignored. A flaky test blocks merge until
it is fixed or explicitly quarantined. Quarantine requires all of the
following in the same change:

1. a tracked issue linked from the test;
2. a named owner and removal condition;
3. movement into a visibly named, non-required quarantine job rather than an
   inline skip in the consolidated suite; and
4. an update to the acceptance-coverage check so no `Done` criterion loses
   its required blocking coverage.

There is currently no quarantine job and no quarantined test. Any future job
must preserve failure history and must not be accepted as evidence for an
experiment-readiness gate.
