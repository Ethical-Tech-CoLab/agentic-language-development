# Mode R learner-host operator runbook

This runbook qualifies the two-container learner-host reference and bounded
controller/Gateway/evidence software path. Its `baby-a` and `baby-b` Compose
service names identify adapter hosts, not fully separated Baby-twin processes.
The Symbol Gateway and SQLite writer still execute in the Nursery process.
The no-Fort lifecycle path now hosts each of the six signer domains in a separate
no-network container with only its own private socket bind. The Fort-file path
still holds its signer registry in Nursery. Neither path clears V06/B12 or supports the full
Research-Grade claim sentence in `SPECIFICATION.md` §5.2 for E10+ studies.

The [prospective selected authority graph](../protocols/mode-r-authority-graph.v1.json)
names the remaining Baby, adapter, Gateway, Evidence Writer, signer, Controller,
checkpoint, and offline-verifier processes and their permitted calls. Its status
is `design-locked-not-implemented`; the current Compose file is intentionally a
negative reference for the selected B12 gate.

The hashing package now has a bounded Unix-socket signer component: one signer
domain per process, a private socket, exact run/domain identity checks, verified
signatures, and a six-domain registry adapter compatible with the existing
evidence-writer interface. A disposable process test exercises domain/run
rejection and signer death. The no-Fort Compose lifecycle now uses this component
with ephemeral keys and distinct signer containers. It still has no Fort-backed
per-domain key provisioning, selected E10+ topology, separate Baby twins, or
separate per-role ledger writers; it is not a B12 qualification receipt. Distinct signer PIDs cannot
be required across container namespaces; the selected host audit must prove
distinct container identities and mounts.
An evidence-writer integration test also commits a real signed turn through
six separate signer processes, then kills one signer and confirms the next
turn leaves no partial ledger or channel event. This tests the interface and
transaction boundary in a disposable fixture, not the selected deployment.

## Prerequisites

- Linux or macOS with Docker Engine/Colima running;
- Docker Compose v2 available as `docker compose`;
- Homebrew-managed Node.js 24.20 and pnpm 12.3.4; and
- a clean checkout with dependencies installed by `pnpm install --frozen-lockfile`.

No Base key, RPC URL, or secret is needed for this isolation qualification.
The Compose networks are internal and the smoke run performs no anchoring.

## One-command qualification

From the repository root, run:

```sh
pnpm run test:mode-r
```

The command builds the hardened learner image, starts the two adapter hosts on
distinct internal networks, proves their container/process IDs differ, runs
the twelve side-channel attacks, kills the `baby-a` host and proves the `baby-b` host survives, then
recreates both hosts for `scratch-rl`, `self-supervised`, and `hybrid` and
proves each update changes only its local policy. It removes its project,
volumes, and containers on exit. Any failed assertion exits non-zero.

## Full-lifecycle topology qualification

Run all four learner tracks through the in-Nursery controller, Gateway, SQLite writer,
checkpoint, local qualification anchor, exporter, verifier, and six isolated
ephemeral signer containers:

```sh
pnpm run test:mode-r-study
```

The wrapper now requires a clean source commit and writes one
`terminal.json` under its ignored evidence directory before container cleanup.
That original file records the source tree/version, all four results, and the
host-inspected signer container identities. If collection fails, it retains a
separate minimal `attempt-failure.json` without converting a partial attempt
into a pass. A separate original-bundle audit now has a [bounded portable receipt](../reports/research/mode-r-signer-reference-audit-receipt.json)
for the frozen v0.1.209 reference execution. From a clean checkout, check its
Git ancestry, scope, and internal structure with
`pnpm run audit:mode-r-signer-reference:receipt`. With the separately retained
ignored `evidence/validation/mode-r-study-2358394/` directory and a built Rust
auditor, run `pnpm run audit:mode-r-signer-reference:live` to recompute all four
original bundles. The portable check alone does not replay raw evidence.

This is a bounded software/topology qualification only, not the selected E10+
process/key topology. Its receipt states
`researchFinding: false` and `publicChainTransaction: false`; the local fake-chain
receipt is not evidence of public anchoring.

To exercise the Fort-to-Nursery signer-material boundary, first store the version-1 signer
envelope in the matching encrypted `safe` environment, then let Fort materialize
it for only the Nursery service:

```sh
si fort run --repo agentic-language-development --env dev \
  --keys ALD_RUN_SIGNER_SEEDS_JSON --mode files -- \
  pnpm run test:mode-r-study
```

The envelope's `runs` map must contain `mode-r-study-no-learning`,
`mode-r-study-scratch-rl`, `mode-r-study-self-supervised`, and
`mode-r-study-hybrid`; each value must contain the exact six signer domains as
64-character lowercase hexadecimal seeds. Do not create a plaintext envelope
outside Fort. Neither learner receives the file, its path, or its contents.
This mount control does not put each signer in a separate process or clear
the V06/B12 key-isolation gate.

## Inspect a standing deployment

For operator inspection, use an explicit project name:

```sh
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml up --build --detach baby-a baby-b
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml ps
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml run --rm --no-deps nursery both
```

`ps` must show two running adapter-host services. The `nursery both` check must
report distinct container IDs and successful network, filesystem, clipboard,
process, worker, timing, size, error-shape, and cross-object isolation checks.

Exercise every trainable track:

```sh
ALD_LEARNER_TRACK=scratch-rl docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml up --detach --force-recreate baby-a baby-b
ALD_LEARNER_TRACK=scratch-rl docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml run --rm --no-deps nursery training scratch-rl
ALD_LEARNER_TRACK=self-supervised docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml up --detach --force-recreate baby-a baby-b
ALD_LEARNER_TRACK=self-supervised docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml run --rm --no-deps nursery training self-supervised
ALD_LEARNER_TRACK=hybrid docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml up --detach --force-recreate baby-a baby-b
ALD_LEARNER_TRACK=hybrid docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml run --rm --no-deps nursery training hybrid
```

Clean up the exact project when finished:

```sh
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml down --volumes --remove-orphans
```

Do not apply a Research-Grade claim when any check fails. Preserve the command
output, container logs, image digest, commit, and Run Configuration with the
qualification evidence before diagnosing or rerunning.
