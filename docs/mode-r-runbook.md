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
and its [v2 capability amendment](../protocols/mode-r-authority-graph.v2.json)
name the required Baby, adapter, Gateway, Evidence Writer, signer, Controller,
Checkpoint, Anchor, delayed Audit Interpreter, and offline-verifier processes.
The amendment binds the unchanged v1 file by hash and assigns distinct writer
sockets and method allowlists to Gateway, Controller, Checkpoint, Anchor, and
Audit Interpreter. Both designs remain `design-locked-not-implemented`; the
current Compose file is intentionally a negative reference for the B12 gate.
The [v3 Gateway-service amendment](../protocols/mode-r-authority-graph.v3.json)
binds v1/v2 unchanged and freezes the exact Controller-to-Gateway method set,
private socket mount, identity descriptor, operational-status envelope, and
no-retry quarantine behavior required before moving the live Gateway. Its
service boundary is now component-qualified and injectable into Nursery, but
the selected container mounts and complete lifecycle are not qualified.
The [prospective v4 recovery amendment](../protocols/mode-r-authority-graph.v4.json)
binds v3 unchanged and replaces its batch-only recovery call with one verified
prefix restoration. The Controller must reconstruct the rejection streak from
signed channel evidence after the latest audited resume, while the Gateway
atomically restores that counter and discards its volatile shuffled batch. The
v4 file preserves its design-time status; the exact `symbol-gateway-v2`
recovery contract is now implemented and component-qualified below. This does
not qualify the selected container topology or close B12.
The [v5 learner-relay amendment](../protocols/mode-r-authority-graph.v5.json)
fixes the two role-specific Controller-to-Gateway sockets and Gateway-only Baby
destinations. The [v6 witness-signing amendment](../protocols/mode-r-authority-graph.v6.json)
corrects an omitted implemented dependency: the Evidence Writer signs turn
records with the witness domain, while the Checkpoint Service signs manifests
with that same domain. It prospectively authorizes both hash-only callers to
one key-owning signer process and keeps every other process off that socket.
Neither amendment is execution evidence or B12 closure.
The new `docker-compose.application.v1.yml` is a separate prospective
application surface; historical E02 and reference Compose files are unchanged.
It maps all seventeen graph processes, three internal networks, five writer
capabilities, three service capabilities, two Gateway learner relays, two
networkless Baby/model sockets, six signer domains, and the v6 witness mount.
Real deployment entrypoints execute two signed development turns, one delayed
audit append, bundle export, and offline verification. The single-use collector
fails closed on dirty source or reused evidence and compares resolved mounts and
networks to live containers before teardown. The image builds and focused
source tests pass; no application execution receipt exists yet, so this remains
implemented but unexecuted development infrastructure and B12 stays open.
The Gateway now accepts a six-method write-only evidence port at its type boundary;
a test exercises accepted and rejected turns through a port without registration,
read, checkpoint, or anchor methods. The current Nursery still passes an in-process
writer, so this is not yet a process or runtime capability boundary.
An isolated Controller writer-port component now has the v2 fifteen-method
allowlist, a run-bound handshake, private Unix socket checks, bounded frames,
and no client retry. Its child-process test registers a run, appends a signed
turn and an intervention, rejects Gateway/audit methods and a wrong run, and
checks the retained SQLite rows after writer death. The live Nursery does not
yet use this port: its synchronous reads and checkpoint dependencies still
require migration, and socket-mount exclusivity has not been measured.
The delayed Audit Interpreter accepts only ledger reads and audit-ledger appends
through its source-level evidence port. Its separate service endpoint accepts
only validated, run-bound `appendBatch` requests and validates every returned
signed audit entry; the Controller no longer constructs the interpreter from an
evidence-writer capability.
The audit-writer socket component now exists separately from the Controller
capability: it permits only role-ledger reads and signed audit appends for one
run. A child-process component test connects the real delayed interpreter,
rejects a too-early source, appends after the delay, rejects Gateway methods,
and checks the retained SQLite row. Local production still supplies an in-process
implementation. The remote application component fixture instead connects the
real interpreter process to the dedicated audit-writer socket and gives Nursery
only the narrow service client. This does not qualify the selected audit
container or its exclusive socket mount.
The Checkpoint writer-port component now exposes only run metadata, checkpoint
and event reads, and manifest insertion over its own private socket. A real
writer child accepts a witness-signed manifest generated by the Checkpoint
Service and rejects wrong-run and unrelated writer calls. The production
Checkpoint Service now awaits all evidence reads and its manifest insert. A
three-process test uses that service with a distinct writer and witness signer,
then verifies its manifest, inclusion/consistency proofs, proof files, skipped
interval, and refusal after signer death. Current Nursery assembly still
injects in-process evidence; this does not establish selected mounts, routes,
resource bounds, or comprehensive fault behavior.
The single-owner writer host can open the Controller, Gateway, Checkpoint,
simulated Anchor, and Audit Interpreter capability sockets over one writer
object and SQLite connection. Its integration test registers through the
Controller socket, commits a turn through Gateway, appends a delayed audit,
creates a witness-signed checkpoint, and confirms a local simulated anchor;
all five clients report the same distinct writer-process identity and expose
the v2 graph's exact method sets. This does not establish caller-exclusive
container mounts or migrate the live Nursery runtime onto those clients.
Bundle export now awaits its complete read surface, so the same Controller
capability can produce the canonical bundle without direct SQLite access. The
shared-host test exports the remotely read signed channel event and simulated
anchor receipt. Nursery lifecycle and recovery reads remain synchronous and
must migrate before the live runtime can use this path end to end.
Nursery now constructs the exact asynchronous Controller capability even for
its local writer and uses it for turn records, lifecycle interventions,
analysis attachments, and recovery. Source guards prevent those operations
from returning to the broad writer handle. Registration, synchronous research
queries, experiment-record history, and reconstruction reads still use the
local writer, so a remote endpoint cannot yet replace it.
Experiment-record construction now awaits the Controller capability for prior
versions, analysis-attachment references, and the append itself; seal-file
rewrites and the `run.sealed` checkpoint reference use the same read surface.
The local adapter normalizes void writes exactly like the socket wire. Public
synchronous research getters and restart reconstruction still retain direct
local-reader dependencies.
Restart reconstruction now awaits Controller-capability metadata, turn,
intervention, checkpoint, experiment-history, fork-artifact, signer-key, and
signed-stream reads. Integrity prechecks parse stored canonical rows before
chain verification, preserving the existing verification semantics across the
asynchronous boundary. Public synchronous query/replay methods and initial
writer construction remain local.
New-run registration now uses the awaited Controller capability and confirms
the configuration hash before lifecycle initialization. A source guard rejects
return to direct writer registration. The writer object is still constructed
inside Nursery, so this is a provisioning prerequisite rather than remote
writer integration.
Live lifecycle decisions now read through that same run-bound Controller
capability: prospective causal-history commitments, final-seal detection,
restart turn/orphan checks, restored probe schedules, and mandatory-chain
checkpoint counters no longer read the broad writer directly. The remaining
concrete handle serves synchronous public inspection/export surfaces, the
private learner-ledger client, delayed-audit construction, and local component
assembly. This narrows the selected ownership seam but does not qualify B12.
Nursery now requests one explicit evidence context per run instead of separately
constructing writer, Controller, Gateway, and Checkpoint dependencies in both
creation and reconstruction. Production provisions exactly one local writer
owner, issues its run-bound Controller and Gateway capabilities, and retains the
same Checkpoint Service for proof export without a mutable pending-run handoff;
concurrent-run coverage verifies the identities remain separated. The context's
local-writer field is deliberately labeled transitional because synchronous
inspection and learner-private-ledger clients still require it. Remote contexts cannot be
claimed until those consumers migrate and the selected process mounts qualify.
The delayed Audit Interpreter now receives its single-method service capability
from the same per-run context; live interpretation no longer constructs itself
from any writer handle. Local production supplies an in-process service, while
the remote component context supplies the separately hosted interpreter client.
This removes the Controller's audit-writer authority but does not prove the
selected container or exclusive mount.
Nursery bundle export now supplies the run-bound Controller capability to the
already asynchronous exporter. Sealing no longer gives that component the
concrete writer, while canonical metadata, stream, signer, checkpoint, anchor,
attachment, and experiment-record reads remain unchanged and validated by the
exporter. Synchronous public inspection methods remain transitional.
Learner maintenance writes now receive an append-only private-ledger evidence
port from the per-run context instead of a concrete writer. For local learners,
the role-bound client fixes run ID, Baby ID, and the Controller-owned current
turn for every append; a capture-only capability test checks those values and
exposes no other method. A selected remote context may omit both that port and
the Gateway writer capability when its Gateway-hosted relays terminate Baby
ledger callbacks; an unexpected reverse callback then fails closed in Nursery.
The eleven-process component fixture uses this shape, so its Controller holds
neither capability. This is a source and component boundary, not selected mount
evidence or B12 closure.
The first `symbol-gateway-v1` service component exposed the v3 method set
over the same bounded private-socket transport used by the writer capabilities.
A distinct Gateway child connects to a distinct writer child through the
durable no-retry journal; the Controller client checks run/configuration
identity, validates replies, tracks only confirmed rejection state, and enters
local quarantine after Gateway loss. Component coverage exercises wrong-run and
wrong-configuration refusal, rejection/reset/accepted paths, distinct process
IDs, socket mode, retained signed events, and post-crash refusal. This remains
component evidence rather than selected-topology lifecycle, mount/network,
comprehensive fault, resource, or independent-audit evidence.
Nursery creation and reconstruction now request a Gateway through an async
run/configuration-bound factory; local operation retains the durable journal
and in-process Gateway, while Mode R may inject the remote client without
receiving a writer capability. `RunRuntime` retains only a narrow quarantine
closure: local assembly combines the durable journal and Gateway state so an
unresolved pre-restart intent still refuses recovery, while a remote client
reports its own fail-closed state. An integration test executes a real Nursery turn through
a separate Gateway child and the parent-owned writer service, then verifies
the retained signed channel event. The `symbol-gateway-v2` implementation now
derives the consecutive-rejection streak only after the complete signed prefix
and turn accounting verify. It checks the latest audited resume's recorded
channel head, restores the current verified head and streak in one Gateway
call, and clears volatile shuffled state. A fresh remote Gateway restart test
retains two prior rejections and reaches the original safety pause after three
more; local tests cover accepted-prefix reset, audited resume, malformed and
mismatched heads, and the configured counter bound. Private RPC startup reclaims
only an unreachable stale socket and refuses to unlink a live service. Selected
container routes/mounts, broader lifecycle faults, resources, and independent
audit remain open and must precede B12 closure.
Nursery's evidence context now makes its local inspection writer optional, and
the runtime database option may be omitted when a remote context factory is
present. Core creation, checkpointing, turn execution, and bundle export use
only the issued capabilities. A multi-process integration test gives Nursery
no database and no writer handle, connects it to a distinct single-owner writer
process and a distinct Gateway process, executes one signed turn, reads it
through the Controller capability, and exports the bundle. The intervention
schedule's ledger reads also use that capability. Synchronous inspection and
some live analysis helpers remain deliberately local-only and fail explicitly
on this remote context; separate signer ownership, caller-exclusive container
mounts, routes, complete lifecycle faults, and resources remain unqualified.
The same remote-writer integration now restarts both Nursery and Gateway while
the single writer remains live. The writer reports its public signer identities
at provisioning; the reconstructed Controller uses those identities for the
mandatory mismatch check but retains signing authority only for the witness.
Recovery verifies the remote prefix, starts a new Gateway process, continues at
the next turn, and still exposes no database or writer handle to Nursery. This
is recovery/process evidence, not proof of selected signer socket mounts or
one-domain-per-signer deployment.
The [prospective container-boundary packet](../protocols/mode-r-boundary-qualification.v1.json)
now freezes the next execution before data collection. It binds all four
authority-graph versions, the already-local pinned image identity, all-pairs
network probes, exact capability/key/state mounts, and zero external spending.
Its scope deliberately excludes application service execution, lifecycle and
fault qualification, resource measurement, independent audit, behavioral
findings, and B12 closure. No boundary result exists until the registered
collector runs and its raw receipt is separately checked.
The packet-driven collector now has distinct development and selected modes.
It refuses a dirty tree or reused evidence root, verifies the pinned image
without pulling, creates uniquely prefixed internal networks and hardened
containers, probes every ordered process pair, inspects exact mounts, signer
domain declarations, container IDs, and host PIDs, and removes only resources
bearing its unique prefix. Failures retain a single-use raw receipt. The first
development attempt failed with 212 route mismatches. Its raw receipt remains
unchanged, and a portable failure supplement records that the fixture did not
authenticate the responding process, did not make liveness an explicit
acceptance metric, and could exit on a client reset. The prospectively amended
collector requires a target-specific response, tolerates reset errors, counts
non-running processes, and uses a fresh development evidence identity. It is
not yet qualified. Its second development attempt also failed because an outer
`docker exec` timeout returned status zero together with `ETIMEDOUT`, which the
collector had not rejected. That raw receipt is also preserved and its apparent
universal reachability is not a topology observation. The next prospective
collector batches probes by source process, requires an explicit completion
payload, rejects every subprocess error or signal, counts incomplete and
wrong-responder outcomes, and uses a third fresh evidence identity. That third
attempt failed closed with 256 incomplete probes because denied hostname lookups
kept the container resolver alive until the outer bound. Its raw receipt is
preserved. The next prospective collector uses inspected target network IPs,
actively checks every available target interface, treats a target with no
network interface as an inspected denial, retains completion and responder
identity checks, and uses a fourth fresh evidence identity. Development attempt
four passed: seventeen distinct running processes, 272 directed routes, 160
literal-interface probes, 34 authenticated allowed endpoints, 126 denied
endpoints, 144 no-interface denials, and zero acceptance mismatches. Its raw
receipt is retained and a portable checker binds the original digest and scope.
At that stage no selected execution had occurred; this was bounded development topology
qualification, not application-runtime qualification, B12 closure, or a
scientific result.
The separately frozen selected source then completed its single-use boundary
collection with the same 17-process, 272-route, and 160-endpoint counts and
zero mismatches. The selected raw receipt is retained and separately audited.
This upgrades the bounded responder topology from development-only to selected
qualification; it still does not execute the application services, lifecycle,
faults, detectors, resource measurements, independent audit, or B12 closure.
The simulated Anchor writer-port component exposes only `listRuns`, checkpoint
and receipt reads, and terminal receipt insertion. Its run-bound `listRuns`
returns only the bound run, even when the writer database contains others.
The child-process test uses the real simulated chain publisher and confirms
that only its one terminal receipt is retained; public-chain and cross-run
requests are refused. The selected Anchor process is not qualified.
The Anchor publisher now awaits its Evidence Store reads and terminal insert,
so it can use that remote port without changing the simulated-chain logic.
The in-flight guard is set before those asynchronous reads; a remote-port
test proves concurrent submissions send one transaction, simultaneous
confirmations insert one receipt, and a different run hash cannot join the
submission. Current Nursery assembly still injects in-process
evidence, and this test does not measure selected mounts or process faults.
The Gateway now quarantines itself when that port reports a possibly committed
write with no confirmed response. A running Controller refuses another turn
before adapter work, and restart recovery refuses channel or affect events that
lack a completed turn record. A separate Gateway write-intent journal component
now durably stores only request/response hashes and refuses an unresolved send
after restart, including when no event committed. Its focused tests cover
confirmed writes, a lost reply before commit, and a late commit after timeout.
The current Nursery now instantiates this journal for each run and checks it
before another turn, resume, or recovery. A focused crash test confirms that
even a lost reply with no signed event refuses recovery. This is local
attempt-level accounting around an in-process writer, not a separate remote
Evidence Writer, and it does not replace selected-topology fault or resource
measurements. Historical runs without this journal do not acquire its coverage
retroactively.
For shuffled batches, the Gateway validates each pre-pass sender envelope,
commits invalid submissions, retains eligible envelopes, seals the artifact
set, and applies the seeded permutation from its own batch state. The
Controller schedules scenario turns but cannot supply or replace the batch
artifact list at delivery. This is still an in-process boundary; it is not
the selected authenticated, separate Gateway process or a B12 qualification.
The Controller now uses the Gateway interface and awaits batch setup, sealing,
recovery discard, and rejection-counter reset. A held-response test verifies
that delivery does not outrun setup or sealing. The writer and Gateway remain
in the Nursery process, so these asynchronous calls are not remote RPC evidence.
A separate component test now runs a real SQLite Evidence Writer in a child
process and calls its six Gateway write operations over a private Unix socket.
The run-bound handshake, method allowlist, bounded frames, response schemas,
and no-retry client are tested; the existing write-intent journal quarantines
a call after writer death. This component is not wired into `nursery-study` or
the selected Compose topology. Its socket permissions are not, by themselves,
proof of authenticated role routes or Controller/Gateway process isolation.
Receiver task-action validation and its private intention append now occur in
the Gateway. The Controller audits an invalid task action and evaluates a valid
one, but no longer calls the Evidence Writer's Baby-ledger append method.
Controller-originated policy-checkpoint and run-seal drafts use a Gateway method
restricted to those two event types. This source boundary is still in-process;
the prospective authority graph needs a new version covering these calls and
the exact Controller writer allowlist before selected-topology qualification.

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

The later v0.1.216 journal-bearing reference has a separate
[portable audit receipt](../reports/research/mode-r-journal-reference-audit-receipt.json).
From a clean checkout, check its commit ancestry and bounded claims with
`pnpm run audit:mode-r-journal-reference:receipt`. With its ignored original
`evidence/validation/mode-r-study-2724959/` directory and the built Rust
auditor, run `pnpm run audit:mode-r-journal-reference:live` to independently
recheck all four bundles and 64 paired write intents. The journal's measured
24,800 logical bytes and 540,672 allocated bytes are for this small reference,
not a full-campaign storage projection. The original terminal still records
that the later independent Rust audit was not part of its execution.

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
