#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'pilot-packet': { type: 'string', default: 'protocols/e03-pilot-registration.v3.json' },
  'pilot-receipt': { type: 'string', default: 'evidence/pilots/e03-blinded-v3/receipt.json' },
  'pilot-reduction': { type: 'string', default: 'evidence/pilots/e03-blinded-v3/sample-size-input.json' },
  'power-receipt': { type: 'string', default: 'evidence/pilots/e03-blinded-v3/power-selection.json' },
  out: { type: 'string', required: true },
  audit: { type: 'boolean', default: false },
} });
const checkedPath = (path, prefix) => {
  assert.ok(path.startsWith(prefix) && !path.split('/').includes('..') &&
    !path.includes('//'), `path must be a repository-relative ${prefix} location`);
  return path;
};
const packetPath = checkedPath(values['pilot-packet'], 'protocols/');
const pilotPath = checkedPath(values['pilot-receipt'], 'evidence/');
const reductionPath = checkedPath(values['pilot-reduction'], 'evidence/');
const powerPath = checkedPath(values['power-receipt'], 'evidence/');
const outputPath = checkedPath(values.out, 'protocols/');
assert.equal(existsSync(outputPath), values.audit,
  values.audit ? 'sample-size decision is missing for audit' :
    'refusing to overwrite a frozen sample-size decision');
const read = (path) => {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
};
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const packet = read(packetPath);
const pilot = read(pilotPath);
const reduction = read(reductionPath);
const power = read(powerPath);
const selectedRow = (sd) => sd <= 0.05 ? 25 : sd <= 0.10 ? 75 :
  sd <= 0.15 ? 155 : sd <= 0.20 ? 300 : undefined;

assert.equal(packet.value.artifact?.experimentId, 'E03');
assert.equal(packet.value.artifact?.parameters?.stage, 'blinded-pilot');
assert.equal(pilot.value.experimentId, 'E03');
assert.equal(pilot.value.stage, 'blinded-pilot');
assert.equal(pilot.value.registrationHash, packet.value.preRegistrationHash);
assert.equal(pilot.value.packetSha256, sha256(packet.bytes));
assert.equal(pilot.value.plannedRuns, 120);
assert.equal(pilot.value.attemptedRuns, 120);
assert.equal(pilot.value.completedRuns, 120);
assert.equal(pilot.value.validRuns, 120);
assert.equal(pilot.value.invalidRuns, 0);
assert.equal(pilot.value.abortedRuns, 0);
assert.equal(pilot.value.passed, true);
assert.equal(pilot.value.failure, null);
assert.equal(pilot.value.sampleSizeEligible, true);
assert.equal(pilot.value.researchFinding, false);
assert.equal(pilot.value.scientificDisposition, 'not-tested');
assert.equal(pilot.value.externalSpend, 0);
assert.equal(pilot.value.publicChainTransaction, false);
assert.equal(pilot.value.slots?.length, 120);

assert.equal(reduction.value.classification, 'outcome-blind-pilot-sample-size-input');
assert.equal(reduction.value.experimentId, 'E03');
assert.equal(reduction.value.pilotSlots, 20);
assert.equal(reduction.value.originalSlotsAudited, 120);
assert.equal(reduction.value.episodesPerSlot, 200);
assert.equal(reduction.value.pilotRegistrationHash, pilot.value.registrationHash);
assert.equal(reduction.value.pilotReceipt?.path, pilotPath);
assert.equal(reduction.value.pilotReceipt?.sha256, sha256(pilot.bytes));
assert.equal(reduction.value.requiresProspectiveAmendment, false);
assert.equal(reduction.value.researchFinding, false);
assert.equal(reduction.value.scientificDisposition, 'not-tested');
assert.ok(Number.isFinite(reduction.value.largestLatentPilotSd) &&
  reduction.value.largestLatentPilotSd >= 0 &&
  reduction.value.selectedPrimarySeeds === selectedRow(reduction.value.largestLatentPilotSd),
'pilot dispersion does not select its frozen candidate row');

assert.equal(power.value.classification, 'outcome-blind-power-simulation');
assert.equal(power.value.experimentId, 'E03');
assert.equal(power.value.decisionRule, 'e03-bounded-complete-numeric-rule-v1');
assert.equal(power.value.pilotRegistrationHash, pilot.value.registrationHash);
assert.equal(power.value.pilotReceipt?.path, pilotPath);
assert.equal(power.value.pilotReceipt?.sha256, sha256(pilot.bytes));
assert.equal(power.value.pilotReduction?.path, reductionPath);
assert.equal(power.value.pilotReduction?.sha256, sha256(reduction.bytes));
assert.equal(power.value.largestLatentPilotSd, reduction.value.largestLatentPilotSd);
assert.equal(power.value.selectedPrimarySeeds, reduction.value.selectedPrimarySeeds);
assert.equal(power.value.monteCarloRepetitions, 30_000);
assert.equal(power.value.monteCarloLower95, power.value.numericRule?.lower95);
assert.ok(power.value.monteCarloLower95 >= 0.9 && power.value.passed === true,
  'nominal complete-rule lower power bound does not authorize a design row');
assert.equal(power.value.invalidAsFailureSensitivity?.forcedFailuresPerCondition,
  Math.ceil(0.05 * power.value.selectedPrimarySeeds));
assert.ok(Number.isInteger(power.value.invalidAsFailureSensitivity?.successes) &&
  power.value.invalidAsFailureSensitivity.successes >= 0 &&
  power.value.invalidAsFailureSensitivity.successes <= 30_000 &&
  Number.isFinite(power.value.invalidAsFailureSensitivity.lower95) &&
  Number.isFinite(power.value.invalidAsFailureSensitivity.upper95) &&
  power.value.invalidAsFailureSensitivity.lower95 >= 0 &&
  power.value.invalidAsFailureSensitivity.upper95 <= 1 &&
  power.value.invalidAsFailureSensitivity.lower95 <=
    power.value.invalidAsFailureSensitivity.upper95,
'invalid-run sensitivity is missing or malformed');
assert.equal(power.value.researchFinding, false);
assert.equal(power.value.scientificDisposition, 'not-tested');
assert.equal(power.value.externalSpend, 0);
assert.equal(power.value.publicChainTransaction, false);

const decision = {
  version: 1,
  classification: 'outcome-blind-pilot-sample-size-selection',
  pilotRegistrationHash: pilot.value.registrationHash,
  pilotReceiptPath: pilotPath,
  pilotReceiptSha256: sha256(pilot.bytes),
  pilotReductionPath: reductionPath,
  pilotReductionSha256: sha256(reduction.bytes),
  powerReceiptPath: powerPath,
  powerReceiptSha256: sha256(power.bytes),
  largestLatentPilotSd: reduction.value.largestLatentPilotSd,
  selectedPrimarySeeds: reduction.value.selectedPrimarySeeds,
  monteCarloRepetitions: 30_000,
  monteCarloLower95: power.value.monteCarloLower95,
  decisionRule: 'e03-bounded-complete-numeric-rule-v1',
  invalidAsFailureSensitivity: {
    forcedFailuresPerCondition: power.value.invalidAsFailureSensitivity.forcedFailuresPerCondition,
    successes: power.value.invalidAsFailureSensitivity.successes,
    lower95: power.value.invalidAsFailureSensitivity.lower95,
    upper95: power.value.invalidAsFailureSensitivity.upper95,
  },
};
const rendered = `${JSON.stringify(decision, null, 2)}\n`;
if (values.audit) {
  assert.equal(readFileSync(outputPath, 'utf8'), rendered,
    'frozen sample-size decision does not reproduce from original input bytes');
  console.log(`audited ${outputPath}`);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered, { flag: 'wx' });
  console.log(`wrote ${outputPath}`);
}
console.log(`E03 selected primary seeds=${decision.selectedPrimarySeeds}; nominal lower95=${decision.monteCarloLower95}; invalid-as-failure successes=${decision.invalidAsFailureSensitivity.successes}`);
