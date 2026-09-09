# Mode R operator runbook

## Prerequisites

- Linux or macOS with Docker Engine/Colima running;
- Docker Compose v2 available as `docker compose`;
- Node.js 22.13 or newer; and
- a clean checkout with dependencies installed by `npm ci`.

No Base key, RPC URL, or secret is needed for this isolation qualification.
The Compose networks are internal and the run performs no anchoring.

## One-command qualification

From the repository root, run:

```sh
npm run test:mode-r
```

The command builds the hardened learner image, starts Baby A and Baby B on
distinct internal networks, proves their container/process IDs differ, runs
the twelve side-channel attacks, kills Baby A and proves Baby B survives, then
recreates both hosts for `scratch-rl`, `self-supervised`, and `hybrid` and
proves each update changes only its local policy. It removes its project,
volumes, and containers on exit. Any failed assertion exits non-zero.

## Inspect a standing deployment

For operator inspection, use an explicit project name:

```sh
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml up --build --detach baby-a baby-b
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml ps
docker compose --project-name ald-mode-r-operator --file deploy/mode-r/docker-compose.yml run --rm --no-deps nursery both
```

`ps` must show two running learner services. The `nursery both` check must
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
