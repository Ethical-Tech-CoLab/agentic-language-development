#!/usr/bin/env tsx

import { readFileSync } from 'node:fs';

interface Review {
  schemaVersion: number;
  reviewClass: string;
  independentHumanReview: boolean;
  decision: string;
  resolvedFindings: Array<{ id: string; owner: string; resolution: string; boundary: string }>;
  blockingFindings: Array<{ id: string; severity: string; owner: string; finding: string; closure: string }>;
  experiments: Array<{ id: string; ready: boolean; blockers: string[] }>;
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
if (review.experiments.some((entry) => entry.ready !== (entry.blockers.length === 0))) {
  throw new Error('an experiment readiness flag contradicts its blocker list');
}
if (review.experiments.filter((entry) => entry.ready).map((entry) => entry.id).join(',') !== 'E00') {
  throw new Error('only the prospectively committed E00 v5 qualification may be ready');
}
const findingIds = new Set(review.blockingFindings.map((finding) => finding.id));
if (findingIds.size !== review.blockingFindings.length) throw new Error('blocking-finding IDs are not unique');
for (const finding of review.blockingFindings) {
  if (finding.finding.length < 20 || finding.closure.length < 20) {
    throw new Error(`${finding.id} lacks an evidence-bearing finding or closure test`);
  }
}
for (const required of ['B07','B08','B09','B10','B11','B12','B13','B14']) {
  if (!findingIds.has(required)) throw new Error(`campaign review omits ${required}`);
}
const resolvedIds = new Set(review.resolvedFindings.map((finding) => finding.id));
if (JSON.stringify([...resolvedIds].sort()) !== JSON.stringify(['B01', 'B02', 'B03', 'B04', 'B05', 'B06'])) {
  throw new Error('campaign review must record B01-B06 as the six prospectively resolved findings');
}
if (review.resolvedFindings.some((finding) => finding.resolution.length < 40 || finding.boundary.length < 40)) {
  throw new Error('a resolved finding lacks a complete resolution or claim boundary');
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

console.log(`campaign readiness review passed: ${String(actual.length)} experiments, ${String(findingIds.size)} blockers, decision=${review.decision}`);
