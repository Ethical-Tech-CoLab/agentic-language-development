#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'pilot-receipt': { type: 'string', required: true },
    'pilot-reduction': { type: 'string', required: true },
    out: { type: 'string', required: true },
  },
});
const sha256 = (bytes) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const readJson = (path) => {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
};
const relativeEvidencePath = (path, label) => {
  if (!path.startsWith('evidence/') || path.split('/').includes('..')) {
    throw new Error(`${label} must be a repository-relative evidence path`);
  }
  return path;
};

const pilotReceiptPath = relativeEvidencePath(values['pilot-receipt'], '--pilot-receipt');
const pilotReductionPath = relativeEvidencePath(values['pilot-reduction'], '--pilot-reduction');
const outputPath = relativeEvidencePath(values.out, '--out');
assert.equal(existsSync(outputPath), false, 'refusing to overwrite a power receipt');

const pilot = readJson(pilotReceiptPath);
const reduction = readJson(pilotReductionPath);
assert.equal(pilot.value.experimentId, 'E03');
assert.equal(pilot.value.stage, 'blinded-pilot');
assert.equal(pilot.value.plannedRuns, 120);
assert.equal(pilot.value.attemptedRuns, 120);
assert.equal(pilot.value.completedRuns, 120);
assert.equal(pilot.value.validRuns, 120);
assert.equal(pilot.value.sampleSizeEligible, true);
assert.equal(pilot.value.scientificDisposition, 'not-tested');
assert.match(pilot.value.registrationHash, /^sha256:[a-f0-9]{64}$/u);
assert.equal(reduction.value.classification, 'outcome-blind-pilot-sample-size-input');
assert.equal(reduction.value.researchFinding, false);
assert.equal(reduction.value.scientificDisposition, 'not-tested');
assert.equal(reduction.value.pilotSlots, 20);
assert.equal(reduction.value.episodesPerSlot, 200);
assert.equal(reduction.value.pilotRegistrationHash, pilot.value.registrationHash);
assert.equal(reduction.value.pilotReceipt?.path, pilotReceiptPath);
assert.equal(reduction.value.pilotReceipt?.sha256, sha256(pilot.bytes));
assert.equal(reduction.value.requiresProspectiveAmendment, false);
assert.ok([25, 75, 155, 300].includes(reduction.value.selectedPrimarySeeds));

const rscript = '/home/linuxbrew/.linuxbrew/bin/Rscript';
assert.equal(existsSync(rscript), true, 'Homebrew Rscript is required');
const scriptPath = 'scripts/e03-power-selection.R';
const scriptBytes = readFileSync(scriptPath);
const temporary = mkdtempSync(`${tmpdir()}/ald-e03-power-`);
const tsvPath = resolve(temporary, 'power.tsv');
try {
  const result = spawnSync(
    rscript,
    [
      scriptPath,
      tsvPath,
      String(reduction.value.largestLatentPilotSd),
      String(reduction.value.selectedPrimarySeeds),
    ],
    { encoding: 'utf8', timeout: 2 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const [header, row, ...extra] = readFileSync(tsvPath, 'utf8').trim().split('\n');
  assert.equal(extra.length, 0, 'power calculation must emit exactly one row');
  const keys = header.split('\t');
  const values = row.split('\t').map(Number);
  assert.equal(keys.length, values.length);
  assert.ok(values.every(Number.isFinite), 'power calculation emitted a non-finite value');
  const fields = Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  assert.equal(fields['largest_latent_pilot_sd'], reduction.value.largestLatentPilotSd);
  assert.equal(fields['primary_seeds'], reduction.value.selectedPrimarySeeds);
  assert.equal(fields['repetitions'], 30_000);

  const receipt = {
    schemaVersion: 1,
    experimentId: 'E03',
    classification: 'outcome-blind-power-simulation',
    researchFinding: false,
    scientificDisposition: 'not-tested',
    decisionRule: 'e03-bounded-complete-numeric-rule-v1',
    pilotRegistrationHash: pilot.value.registrationHash,
    pilotReceipt: { path: pilotReceiptPath, sha256: sha256(pilot.bytes) },
    pilotReduction: { path: pilotReductionPath, sha256: sha256(reduction.bytes) },
    implementation: { path: scriptPath, sha256: sha256(scriptBytes), runtime: 'Homebrew base R' },
    largestLatentPilotSd: fields['largest_latent_pilot_sd'],
    selectedPrimarySeeds: fields['primary_seeds'],
    monteCarloRepetitions: fields['repetitions'],
    simulationSeed: fields['simulation_seed'],
    numericRule: {
      successes: fields['numeric_successes'],
      estimatedPower: fields['numeric_power'],
      lower95: fields['numeric_lower95'],
      upper95: fields['numeric_upper95'],
    },
    invalidAsFailureSensitivity: {
      forcedFailuresPerCondition: fields['invalid_as_failure_count'],
      successes: fields['invalid_as_failure_successes'],
      estimatedPower: fields['invalid_as_failure_power'],
      lower95: fields['invalid_as_failure_lower95'],
      upper95: fields['invalid_as_failure_upper95'],
    },
    monteCarloLower95: fields['numeric_lower95'],
    passed: fields['numeric_lower95'] >= 0.9,
    externalSpend: 0,
    publicChainTransaction: false,
    claimBoundary:
      'Separately implemented outcome-blind E03 power calculation only; no experiment outcome, ' +
      'qualification decision, behavioral finding, or public timestamp.',
  };
  await mkdir(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  console.log(`wrote ${outputPath}`);
  console.log(`E03 bounded numeric-rule lower95=${String(receipt.monteCarloLower95)}; passed=${String(receipt.passed)}`);
  if (!receipt.passed) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
