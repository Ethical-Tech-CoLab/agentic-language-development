#!/usr/bin/env tsx

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface ReceiptRow {
  experiment: string;
  caseName: string;
  metric: string;
  value: number;
  n: number;
  assumption: string;
}

interface Protocol {
  schemaVersion: number;
  causalLedger: {
    freezeSequence: string[];
    comparators: Array<{ id: string; allowed: string[]; forbidden: string[]; role: string }>;
  };
  leakage: Record<string, { allowed: string[]; forbidden: string[]; positiveControls?: string; positiveControl?: string }>;
  operatingCharacteristics: {
    script: string;
    scriptSha256: string;
    receipt: string;
    receiptSha256: string;
    acceptance: {
      minimumClearanceProbability: number;
      maximumBoundaryTypeI: number;
      minimumPositiveControlDetection: number;
    };
  };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseReceipt(path: string): ReceiptRow[] {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  if (lines.shift() !== 'experiment\tcase\tmetric\tvalue\tn\tassumption') {
    throw new Error('unexpected leakage-design receipt header');
  }
  return lines.map((line, index) => {
    const fields = line.split('\t');
    if (fields.length !== 6) throw new Error(`receipt row ${String(index + 2)} is malformed`);
    const value = Number(fields[3]);
    const n = Number(fields[4]);
    if (!Number.isFinite(value) || value < 0 || value > 1 || !Number.isInteger(n) || n < 1) {
      throw new Error(`receipt row ${String(index + 2)} has an invalid value or sample size`);
    }
    return {
      experiment: fields[0] as string,
      caseName: fields[1] as string,
      metric: fields[2] as string,
      value,
      n,
      assumption: fields[5] as string,
    };
  });
}

const protocolPath = 'protocols/causal-ledger-and-leakage.v1.json';
const protocol = JSON.parse(readFileSync(protocolPath, 'utf8')) as Protocol;
if (protocol.schemaVersion !== 1) throw new Error('unexpected causal/leakage schema version');

const operating = protocol.operatingCharacteristics;
if (sha256(operating.script) !== operating.scriptSha256) {
  throw new Error('leakage-design R script hash does not match the protocol');
}
if (sha256(operating.receipt) !== operating.receiptSha256) {
  throw new Error('leakage-design receipt hash does not match the protocol');
}

let receiptPath = operating.receipt;
let temporaryDirectory: string | undefined;
if (process.argv.includes('--live-r')) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'ald-leakage-design-'));
  receiptPath = join(temporaryDirectory, 'leakage-design-validation.tsv');
  const result = spawnSync('Rscript', [operating.script, receiptPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`independent R validation failed: ${result.stderr}`);
  if (sha256(receiptPath) !== operating.receiptSha256) {
    throw new Error('live R leakage-design receipt differs from the frozen receipt');
  }
}

const rows = parseReceipt(receiptPath);
if (rows.length !== 6) throw new Error(`expected 6 receipt rows, found ${String(rows.length)}`);
const find = (experiment: string, caseName: string): ReceiptRow => {
  const matches = rows.filter((row) => row.experiment === experiment && row.caseName === caseName);
  if (matches.length !== 1) throw new Error(`missing unique receipt row ${experiment}/${caseName}`);
  return matches[0] as ReceiptRow;
};
for (const experiment of ['E02', 'E20']) {
  const clearanceCase = experiment === 'E20' ? 'zero-excess-clearance' : 'chance-clearance';
  if (find(experiment, clearanceCase).value < operating.acceptance.minimumClearanceProbability) {
    throw new Error(`${experiment} negative-bound clearance probability is below the floor`);
  }
  if (find(experiment, 'margin-boundary-type-i').value > operating.acceptance.maximumBoundaryTypeI + 1e-12) {
    throw new Error(`${experiment} boundary Type I error exceeds alpha`);
  }
  if (find(experiment, 'positive-control-detection').value < operating.acceptance.minimumPositiveControlDetection) {
    throw new Error(`${experiment} positive-control detection is below the floor`);
  }
}

const comparatorIds = protocol.causalLedger.comparators.map((entry) => entry.id);
for (const required of ['uniform', 'validation-majority', 'transcript-only', 'task-history', 'policy-state', 'oracle-diagnostic']) {
  if (!comparatorIds.includes(required)) throw new Error(`missing causal-ledger comparator ${required}`);
}
if (protocol.causalLedger.freezeSequence.length < 7) {
  throw new Error('causal-ledger chronology is incomplete');
}
for (const experiment of ['E01', 'E02', 'E13', 'E20']) {
  const rule = protocol.leakage[experiment];
  if (rule === undefined || rule.allowed.length === 0 || rule.forbidden.length === 0) {
    throw new Error(`${experiment} lacks explicit allowed/forbidden information sets`);
  }
  if (rule.positiveControl === undefined && rule.positiveControls === undefined) {
    throw new Error(`${experiment} lacks a detector-positive control`);
  }
}

const carrierSource = readFileSync('packages/analysis/src/carrier-leakage.ts', 'utf8');
if (!carrierSource.includes('intendedCarrierFeatureUseDiagnostic') || carrierSource.includes('unintendedFeatureProbe')) {
  throw new Error('carrier form use is still misclassified as prohibited leakage');
}
const semanticSource = readFileSync('packages/leakage/src/index.ts', 'utf8');
for (const required of ['negativeBoundDecision', 'positiveControl', 'minimumTestRows', 'majorityBaselineAccuracy']) {
  if (!semanticSource.includes(required)) throw new Error(`semantic leakage gate lacks ${required}`);
}
const affectSource = readFileSync('packages/analysis/src/affect-leakage.ts', 'utf8');
for (const required of ['studentTQuantile', "'insufficient-seeds'", 'bootstrapSensitivity']) {
  if (!affectSource.includes(required)) throw new Error(`affect leakage gate lacks ${required}`);
}

if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true });
console.log(`causal/leakage design audit passed (${String(rows.length)} operating-characteristic rows)`);
