#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

interface Allocation {
  experiment: string;
  class: string;
  conditions: string[];
  stage: string;
  slots: number;
  reserves: number;
  turnsPerRun: number;
}

interface Protocol {
  schemaVersion: number;
  seedDerivation: { root: string; stageDomains: string[] };
  sampleSizeRule: {
    targetPower: number;
    monteCarloLowerConfidenceFloor: number;
    provisionalPlanningN: number;
    candidatePrimarySeeds: number[];
  };
  allocations: Allocation[];
  replication: {
    stage: string;
    sourceExperiments: string[];
    conditionsPerSlot: number;
    slots: number;
    reserves: number;
    plannedBundles: number;
  };
  resourceBenchmark: {
    turns: number;
    wallSeconds: number;
    bytes: number;
    bytesPerTurn: number;
  };
  localCeiling: { cpuHours: number; workingStorageGiB: number; externalSpend: number };
  planningAccounting: {
    maximumMaterializedBundlesIncludingReplication: number;
    maximumMaterializedTurns: number;
    projectedUncompressedGiBAtMeasuredRate: number;
    projectedSingleCoreHoursAtMeasuredRate: number;
  };
}

const protocolPath = 'protocols/seed-and-resource-allocation.v1.json';
const reportPath = 'reports/research/seed-resource-ledger.json';
const protocolBytes = readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes.toString('utf8')) as Protocol;
const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
const derive = (...parts: Array<string | number>): string =>
  hash(parts.map(String).join('\u0000'));

if (protocol.schemaVersion !== 1) throw new Error('unexpected seed/resource schema version');
if (protocol.sampleSizeRule.targetPower !== 0.9 || protocol.sampleSizeRule.monteCarloLowerConfidenceFloor !== 0.9) {
  throw new Error('sample-size selection must require a 0.90 lower power bound');
}
if (!protocol.sampleSizeRule.candidatePrimarySeeds.includes(protocol.sampleSizeRule.provisionalPlanningN)) {
  throw new Error('provisional N is absent from the candidate grid');
}
if (protocol.localCeiling.externalSpend !== 0) throw new Error('local plan must not authorize external spend');

const experimentIds = new Set(protocol.allocations.map((entry) => entry.experiment));
for (const required of ['E00','E01','E02','E03','E10','E11','E12','E13','E14','E15','E16','E20','E21','E22','E30','E31','E32','E40']) {
  if (!experimentIds.has(required)) throw new Error(`allocation omits ${required}`);
}

const allSeeds = new Set<string>();
const rows = protocol.allocations.map((allocation) => {
  if (!protocol.seedDerivation.stageDomains.includes(allocation.stage)) {
    throw new Error(`${allocation.experiment} uses an unknown seed stage`);
  }
  if (new Set(allocation.conditions).size !== allocation.conditions.length) {
    throw new Error(`${allocation.experiment} repeats a condition`);
  }
  const allocationSeeds: string[] = [];
  for (let slot = 1; slot <= allocation.slots + allocation.reserves; slot += 1) {
    const scenario = derive(protocol.seedDerivation.root, allocation.stage, allocation.experiment, slot, 'scenario');
    allocationSeeds.push(scenario);
    for (const condition of allocation.conditions) {
      for (const role of ['baby-a', 'baby-b']) {
        allocationSeeds.push(derive(protocol.seedDerivation.root, allocation.stage, allocation.experiment, condition, slot, role, 'learner'));
      }
      allocationSeeds.push(derive(protocol.seedDerivation.root, allocation.stage, allocation.experiment, condition, slot, 'gateway'));
      allocationSeeds.push(derive(protocol.seedDerivation.root, allocation.stage, allocation.experiment, condition, slot, 'analysis'));
    }
  }
  for (const seed of allocationSeeds) {
    if (allSeeds.has(seed)) throw new Error(`seed collision at ${allocation.experiment}/${allocation.stage}`);
    allSeeds.add(seed);
  }
  const bundles = allocation.conditions.length * (allocation.slots + allocation.reserves);
  return {
    experiment: allocation.experiment,
    stage: allocation.stage,
    conditions: allocation.conditions.length,
    primarySlots: allocation.slots,
    reserveSlots: allocation.reserves,
    bundles,
    turns: bundles * allocation.turnsPerRun,
    allocationCommitment: hash(allocationSeeds.join('\n')),
  };
});

const nonReplicationBundles = rows.reduce((sum, row) => sum + row.bundles, 0);
const nonReplicationTurns = rows.reduce((sum, row) => sum + row.turns, 0);
const replicationTurnsPerSlot = protocol.replication.sourceExperiments.reduce((sum, experiment) => {
  const row = protocol.allocations.find((entry) => entry.experiment === experiment && entry.stage === 'confirmatory');
  if (row === undefined) throw new Error(`replication source ${experiment} lacks a confirmatory allocation`);
  return sum + row.conditions.length * row.turnsPerRun;
}, 0);
const replicationBundles = protocol.replication.conditionsPerSlot * (protocol.replication.slots + protocol.replication.reserves);
const replicationTurns = replicationTurnsPerSlot * (protocol.replication.slots + protocol.replication.reserves);
if (replicationBundles !== protocol.replication.plannedBundles) throw new Error('replication bundle formula mismatch');

const totalBundles = nonReplicationBundles + replicationBundles;
const totalTurns = nonReplicationTurns + replicationTurns;
const projectedGiB = totalTurns * protocol.resourceBenchmark.bytesPerTurn / 2 ** 30;
const projectedHours = totalTurns * (protocol.resourceBenchmark.wallSeconds / protocol.resourceBenchmark.turns) / 3600;
const accounting = protocol.planningAccounting;
const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`accounting mismatch: ${String(actual)} versus ${String(expected)}`);
};
close(protocol.resourceBenchmark.bytes / protocol.resourceBenchmark.turns, protocol.resourceBenchmark.bytesPerTurn);
close(totalBundles, accounting.maximumMaterializedBundlesIncludingReplication);
close(totalTurns, accounting.maximumMaterializedTurns);
close(projectedGiB, accounting.projectedUncompressedGiBAtMeasuredRate);
close(projectedHours, accounting.projectedSingleCoreHoursAtMeasuredRate);

const report = {
  schemaVersion: 1,
  classification: 'outcome-blind-design-evidence',
  researchFinding: false,
  protocolSha256: hash(protocolBytes),
  seedAlgorithm: 'sha256-nul-separated-v1',
  distinctDerivedSeeds: allSeeds.size,
  collisions: 0,
  allocations: rows,
  totals: {
    nonReplicationBundles,
    replicationBundles,
    maximumMaterializedBundles: totalBundles,
    nonReplicationTurns,
    replicationTurns,
    maximumMaterializedTurns: totalTurns,
    projectedUncompressedGiBAtMeasuredRate: projectedGiB,
    projectedSingleCoreHoursAtMeasuredRate: projectedHours,
    fitsLocalWorkingStorageCeiling: projectedGiB <= protocol.localCeiling.workingStorageGiB,
    fitsLocalCpuCeiling: projectedHours <= protocol.localCeiling.cpuHours,
  },
  boundary: 'Maximum pools are prospective identifiers, not permission to execute or evidence that resources, governance, registration, anchors, or external review exist.',
};
const rendered = `${JSON.stringify(report, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(reportPath, rendered);
  console.log(`wrote ${reportPath}`);
} else if (readFileSync(reportPath, 'utf8') !== rendered) {
  throw new Error('seed/resource ledger is stale; run pnpm run build:seed-resource-ledger');
}

console.log(`seed/resource allocation valid: ${String(allSeeds.size)} unique derived seeds, ${String(totalBundles)} maximum bundles, ${projectedGiB.toFixed(1)} GiB projected`);
