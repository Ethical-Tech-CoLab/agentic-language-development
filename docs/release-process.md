# Release process

Normative words (`MUST`, `MUST NOT`, `SHOULD`, `MAY`) retain the meanings in
RFC 2119/RFC 8174 and SPECIFICATION §2. Release notes use ordinary descriptive
language unless they intentionally impose a conformance requirement.

The root `package.json` is the repository version source. Development commits
that change tracked content increment the patch component in the same commit.
A published release increments the minor component, resets patch to zero, and
is the only kind of commit that receives a Git tag. Major version changes are
reserved for an explicitly approved incompatible evidence or protocol
contract.

## Before a release

1. Require the `consolidated-suite` and `mode-r` CI jobs to pass on the exact
   release commit. Do not retry a failure into green.
2. Confirm `pnpm run check` and `pnpm run test:mode-r` locally when the release
   changes runtime, isolation, evidence, or deployment behavior.
3. Review `BACKLOG.md`, the publication checklist mapping, open deviations,
   invalid/aborted run indexes, and data/model release restrictions.
4. Build release notes from every commit and patch bump since the previous
   minor tag. Separate fixes, capabilities, conformance changes, known gaps,
   and migrations; do not imply a scientific result from a readiness gate.
5. Change the root version to the next `0.<minor>.0` and update the lockfile in
   the same release commit.

## Tag and publish

After the release commit is reviewed and CI is green, create one annotated tag
named `v<version>` on that exact commit. The tag message and GitHub Release
notes MUST identify the verifier version, evidence schema compatibility,
deployment-mode claim boundary, and all patch commits since the prior tag.
Publish immutable source artifacts and checksums. Publish evidence, data,
models, and Base transaction links only after their study-specific licenses,
privacy restrictions, and verification instructions have been reviewed.

Never move or reuse a release tag. A correction is a new patch development
commit and, when distributed, a new minor release. See
[publication-checklist-mapping.md](publication-checklist-mapping.md) for the
software/research boundary that release approval must preserve.
