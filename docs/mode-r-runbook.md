# Mode R learner-host operator runbook

This runbook qualifies the two-container learner-host reference and bounded
controller/Gateway/evidence software path. Its `baby-a` and `baby-b` Compose
service names identify adapter hosts, not fully separated Baby-twin processes.
The Symbol Gateway, SQLite writer, and signer registry currently execute in
the Nursery process. This path cannot clear V06/B12 or support the full
Research-Grade claim sentence in `SPECIFICATION.md` §5.2 for E10+ studies.

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
checkpoint, local qualification anchor, exporter, and verifier:

```sh
pnpm run test:mode-r-study
```

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
