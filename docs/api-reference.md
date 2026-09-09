# Twin route API reference

The host prefixes each path with its twin name (`/nursery`, `/baby-a`, or
`/baby-b`); the tables show the unprefixed pack route. Every request supplies
`x-ald-role` and `x-ald-service-token`. Human calls may also supply
`x-ald-actor`, which defaults to the authenticated role. Mode P's development
token for role `<role>` is `dev-<role>`; it is not a Mode R credential model.

Every success is JSON `{ "ok": true, ...data }` with status 200 or 201. Every
failure is JSON `{ "ok": false, "error": { "code", "message", "details"? } }`
with one of `INVALID_REQUEST`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`DUPLICATE_ID`, `CHANNEL_REJECTED`, or `CONFLICT`.

## Nursery routes

`researcher-operator` inherits `researcher-viewer` access. `:id` is a
path-safe run ID.

| Route | Authorized role | Request | Success data |
|---|---|---|---|
| `POST /runs` | researcher-operator | a `RunConfig`, or `{ config: RunConfig, preRegistration?: PreRegistrationBinding }` | 201 `{ run: RunSummary }` |
| `POST /runs/:id/step` | internal-controller | empty body | `{ turnResult, run: RunSummary }`; seals automatically when the step enters `sealing` |
| `GET /runs` | researcher-viewer | none | `{ runs: RunSummary[] }` |
| `GET /runs/:id` | researcher-viewer | none | `{ run: RunSummary }` |
| `GET /runs/:id/transcript` | researcher-viewer | none | `{ transcript: ChannelEvent[] }` |
| `GET /runs/:id/ledgers` | researcher-viewer | none | viewer: `{ ledgers: AuditLedgers, agentNativeEventCounts }`; operator: `{ ledgers: NativeLedgers, auditLedgers }` |
| `GET /runs/:id/audit` | researcher-viewer | none | `{ audit: InterventionEvent[] }` |
| `GET /runs/:id/checkpoints` | researcher-viewer | none | `{ checkpoints: CheckpointManifest[] }` |
| `GET /runs/:id/anchors` | researcher-viewer | none | `{ anchors: AnchorReceipt[] }` |
| `GET /runs/:id/telemetry` | researcher-viewer | none | `{ telemetry: TelemetryRecord[] }` |
| `GET /runs/:id/replay` | researcher-viewer | none | `{ replayDigest, scenario, readOnly: true, overrideAllowed: false }` |
| `GET /runs/:id/observations` | researcher-operator | none | `{ observations }`; the private read is audited |
| `POST /runs/:id/pause` | researcher-operator | `{ reasonCode: string, details?: object }` | `{ run: RunSummary }` |
| `POST /runs/:id/resume` | researcher-operator | `{ reasonCode: string, details?: object }` | `{ run: RunSummary }` |
| `POST /runs/:id/abort` | researcher-operator | `{ reasonCode: string, details?: object }` | `{ run: RunSummary }` |
| `POST /runs/:id/annotate` | researcher-operator | `{ reasonCode: string, details?: object }` | `{ event: InterventionEvent }`; creates a checkpoint and deviation reference |
| `GET /runs/:id/verification-report` | researcher-viewer | none | `{ report: VerificationReport }` from the exported file |
| `POST /runs/:id/verify` | researcher-operator | empty body | `{ report: VerificationReport }`; exports, writes proofs, then verifies |
| `POST /session/snapshot` | researcher-operator | empty body | 201 `{ snapshotId: string }` |
| `POST /session/restore` | researcher-operator | `{ snapshotId: string }` | `{ runs: RunSummary[] }` recovered from that session index |
| `GET /session/delta?since=<snapshotId>` | researcher-viewer | query parameter `since` | `{ since, changed: RunSummary[] }` |

## Baby routes

The same six routes exist on both `/baby-a` and `/baby-b`. A request that
names the counterpart anywhere in its body is forbidden. `observe`, `act`,
`deliver`, and `outcome` require the run to be `running` or `evaluating`.

| Route | Authorized role | Request | Success data |
|---|---|---|---|
| `POST /observe` | internal-controller | `{ runId, observation: Observation }`, whose recipient is this Baby | `{}` after hygiene validation and delivery |
| `POST /act` | internal-gateway | `{ runId, turnBudget: TurnBudget }` | `{ envelope: TurnProposalEnvelope }` |
| `POST /deliver` | internal-gateway | `{ runId, delivery: DeliveredChannelArtifact }` | `{ ledgerDraft: LedgerDraftEnvelope }` |
| `POST /outcome` | internal-controller | `{ runId, outcome: OutcomeEvent }` | `{}` |
| `GET /ledger?runId=<id>` | researcher-viewer | query parameter `runId` | `{ ledger: AuditLedgerEntry[], agentNativeEventCount: number }`; never returns native content |
| `POST /reset` | internal-controller | `{ runId }` | currently returns 409 `CONFLICT`; reset occurs only during run creation |

The authoritative schemas are exported by `@ald/types`. New routes must also
be added to the exhaustive authorization/envelope matrix and this document;
`scripts/check-api-docs.mjs` enforces that correspondence.
