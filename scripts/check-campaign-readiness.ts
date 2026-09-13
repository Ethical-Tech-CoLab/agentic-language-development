#!/usr/bin/env tsx

import { accessSync, readFileSync } from 'node:fs';

type ExecutionStage = 'qualification' | 'pilot' | 'confirmatory' | 'analysis' | 'exploratory' | 'replication' | 'reporting';
type GateDecision = 'ready' | 'blocked' | 'complete';
type AttemptStatus = 'not-started' | 'running' | 'completed' | 'failed' | 'aborted';
type ScientificDisposition = 'not-tested' | 'supported' | 'not-supported' | 'inconclusive';

interface ExperimentProgress {
  id: string;
  executionReadiness: { stage: ExecutionStage; decision: GateDecision; reasonCodes: string[] };
  attempt: { version?: string; status: AttemptStatus; planned: number | null; attempted: number; completed: number };
  scientificDisposition: ScientificDisposition;
  evidence: Array<{ kind: string; path: string; statusAuthority: boolean }>;
}

interface Review {
  schemaVersion: number;
  reviewClass: string;
  independentHumanReview: boolean;
  decision: string;
  resolvedFindings: Array<{ id: string; owner: string; resolution: string; boundary: string }>;
  blockingFindings: Array<{ id: string; severity: string; owner: string; finding: string; closure: string }>;
  experiments: ExperimentProgress[];
  safeLocalNextActions: string[];
  prohibitedUntilClosure: string[];
}

const review = JSON.parse(readFileSync('protocols/campaign-readiness-review.v1.json', 'utf8')) as Review;
const cards = JSON.parse(readFileSync('protocols/research-protocol-cards.v1.json', 'utf8')) as { cards: Array<{ id: string }> };
const allocation = JSON.parse(readFileSync('protocols/seed-and-resource-allocation.v1.json', 'utf8')) as {
  planningAccounting: { projectedUncompressedGiBAtMeasuredRate: number; projectedSingleCoreHoursAtMeasuredRate: number };
  localCeiling: { workingStorageGiB: number; cpuHours: number; externalSpend: number };
};

if (review.schemaVersion !== 1 || review.reviewClass !== 'internal-adversarial-methods-review') {
  throw new Error('unexpected campaign review identity');
}
if (review.independentHumanReview || review.decision !== 'not-registration-ready') {
  throw new Error('internal review must not claim independence or readiness');
}
const expected = cards.cards.map((card) => card.id).sort();
const actual = review.experiments.map((entry) => entry.id).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error('campaign review does not cover the same 19 experiment cards');
}
const findingIds = new Set(review.blockingFindings.map((finding) => finding.id));
if (findingIds.size !== review.blockingFindings.length) throw new Error('blocking-finding IDs are not unique');
for (const finding of review.blockingFindings) {
  if (finding.finding.length < 20 || finding.closure.length < 20) {
    throw new Error(`${finding.id} lacks an evidence-bearing finding or closure test`);
  }
}
for (const required of ['B07','B08','B09','B10','B11','B12','B13','B14','B16']) {
  if (!findingIds.has(required)) throw new Error(`campaign review omits ${required}`);
}
const resolvedIds = new Set(review.resolvedFindings.map((finding) => finding.id));
if (JSON.stringify([...resolvedIds].sort()) !== JSON.stringify(['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B15'])) {
  throw new Error('campaign review must record B01-B06 and B15 as the seven resolved findings');
}
if (review.resolvedFindings.some((finding) => finding.resolution.length < 40 || finding.boundary.length < 40)) {
  throw new Error('a resolved finding lacks a complete resolution or claim boundary');
}
const executionStages = new Set<ExecutionStage>(['qualification', 'pilot', 'confirmatory', 'analysis', 'exploratory', 'replication', 'reporting']);
const gateDecisions = new Set<GateDecision>(['ready', 'blocked', 'complete']);
const attemptStatuses = new Set<AttemptStatus>(['not-started', 'running', 'completed', 'failed', 'aborted']);
const scientificDispositions = new Set<ScientificDisposition>(['not-tested', 'supported', 'not-supported', 'inconclusive']);
for (const entry of review.experiments) {
  const { executionReadiness, attempt } = entry;
  if (attempt.version !== undefined && !/^v[1-9][0-9]*$/u.test(attempt.version)) {
    throw new Error(`${entry.id} has an invalid attempt version`);
  }
  if (!executionStages.has(executionReadiness.stage) || !gateDecisions.has(executionReadiness.decision)) {
    throw new Error(`${entry.id} has an invalid execution-readiness state`);
  }
  if (!attemptStatuses.has(attempt.status) || !scientificDispositions.has(entry.scientificDisposition)) {
    throw new Error(`${entry.id} has an invalid attempt or scientific disposition`);
  }
  if ((executionReadiness.decision === 'blocked') !== (executionReadiness.reasonCodes.length > 0)) {
    throw new Error(`${entry.id} readiness decision contradicts its reason codes`);
  }
  for (const reason of executionReadiness.reasonCodes) {
    if (!findingIds.has(reason) && !/^E\d{2}(?:-[a-z]+)?(?:-or-E\d{2})?$/u.test(reason)) {
      throw new Error(`${entry.id} has an unknown readiness reason ${reason}`);
    }
  }
  if (!Number.isInteger(attempt.attempted) || !Number.isInteger(attempt.completed) ||
      attempt.attempted < 0 || attempt.completed < 0 || attempt.completed > attempt.attempted) {
    throw new Error(`${entry.id} has invalid attempt accounting`);
  }
  if (attempt.planned !== null && (!Number.isInteger(attempt.planned) || attempt.planned < attempt.attempted)) {
    throw new Error(`${entry.id} attempt accounting exceeds its planned allocation`);
  }
  if (attempt.status === 'not-started' && (attempt.attempted !== 0 || attempt.completed !== 0)) {
    throw new Error(`${entry.id} is not started but has attempted or completed runs`);
  }
  if (executionReadiness.decision === 'complete' && attempt.status !== 'completed') {
    throw new Error(`${entry.id} cannot complete an execution gate without a completed attempt`);
  }
  if (executionReadiness.decision === 'ready' && (attempt.status === 'failed' || attempt.status === 'aborted')) {
    throw new Error(`${entry.id} cannot be ready while its current attempt is terminally unsuccessful`);
  }
  if (entry.scientificDisposition !== 'not-tested' && attempt.status !== 'completed') {
    throw new Error(`${entry.id} has a scientific disposition without a completed attempt`);
  }
  const authorities = entry.evidence.filter((evidence) => evidence.statusAuthority);
  if (attempt.status === 'not-started' ? authorities.length !== 0 : authorities.length !== 1) {
    throw new Error(`${entry.id} must have exactly one status-authority receipt after starting`);
  }
  for (const evidence of entry.evidence) accessSync(evidence.path);
  if (authorities.length === 1) {
    const receipt = JSON.parse(readFileSync(authorities[0]!.path, 'utf8')) as Record<string, unknown>;
    if (receipt.experimentId !== entry.id) throw new Error(`${entry.id} status receipt belongs to another experiment`);
    const slots = Array.isArray(receipt.slots) ? receipt.slots.length : 0;
    let receiptStatus: AttemptStatus | 'unresolved' = 'unresolved';
    if (receipt.allDispositionsMatched === true && slots === attempt.planned) receiptStatus = 'completed';
    else if (receipt.passed === true && receipt.failure === null && slots === attempt.planned) receiptStatus = 'completed';
    else if (receipt.passed === false && typeof receipt.failure === 'string' && receipt.failure.length > 0) receiptStatus = 'failed';
    else if (receipt.passed === false && receipt.failure === null && slots === attempt.planned) receiptStatus = 'completed';
    if (receiptStatus !== attempt.status || slots !== attempt.completed) {
      throw new Error(`${entry.id} progress contradicts its status-authority receipt`);
    }
  }
}
if (
  allocation.planningAccounting.projectedUncompressedGiBAtMeasuredRate <= allocation.localCeiling.workingStorageGiB ||
  allocation.planningAccounting.projectedSingleCoreHoursAtMeasuredRate <= allocation.localCeiling.cpuHours ||
  allocation.localCeiling.externalSpend !== 0
) {
  throw new Error('resource blocker no longer matches the allocation protocol');
}
if (review.safeLocalNextActions.length < 4 || review.prohibitedUntilClosure.length < 4) {
  throw new Error('campaign review lacks actionable safe/prohibited boundaries');
}
const readinessSource = readFileSync('docs/experiment-readiness-gates.json', 'utf8');
for (const id of expected) {
  if (!readinessSource.includes(`"${id}"`)) throw new Error(`software readiness map omits ${id}`);
}

const ready = review.experiments.filter((entry) => entry.executionReadiness.decision === 'ready').length;
const complete = review.experiments.filter((entry) => entry.executionReadiness.decision === 'complete').length;
console.log(`campaign readiness review passed: ${String(actual.length)} experiments, ${String(findingIds.size)} blockers, ${String(ready)} ready and ${String(complete)} completed gates; decision=${review.decision}`);
