import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { validateConfirmatoryPilotReductionQualification } from
  './qualify-confirmatory-pilot-reduction.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const policy = read('protocols/confirmatory-pilot-reduction.v1.json');
const source = readFileSync('packages/analysis/src/confirmatory-pilot-reduction.ts', 'utf8');

assert.equal(policy.schemaVersion, 1);
assert.equal(policy.classification, 'prospective-confirmatory-pilot-numerical-reduction');
assert.equal(policy.researchFinding, false);
assert.equal(policy.scientificDisposition, 'not-tested');
assert.equal(policy.pilotDataInspected, false);
assert.equal(policy.independentHumanReview, false);
assert.equal(policy.externalSpend, 0);
for (const input of policy.sourcePolicies) assert.equal(sha256(input.path), input.sha256,
  `${input.path}: pilot-reduction source policy changed`);
assert.equal(policy.analysisVersion, 'confirmatory-pilot-reduction/v1');
assert.equal(policy.summaryVersion, 'confirmatory-pilot-summary/v2');
assert.deepEqual(policy.experiments, ['E11','E13','E15','E16','E20','E30','E32']);
assert.equal(policy.primarySlotsPerExperiment, 20);
assert.equal(policy.totalRequiredPrimarySlots, 140);
assert.equal(policy.components, 14);
assert.match(policy.admissionInputs, /separate admission audit/u);
assert.equal(policy.upperDispersion.method, 'normal-chi-square-one-sided-95-n20-v1');
assert.equal(policy.upperDispersion.degreesOfFreedom, 19);
assert.equal(policy.upperDispersion.oneSidedConfidence, 0.95);
const rValues = execFileSync('Rscript', ['--vanilla', '-e',
  'cat(format(qchisq(0.05,19),digits=17),format(sqrt(19/qchisq(0.05,19)),digits=17),sep=",");cat("\\n")'],
{ encoding: 'utf8' }).trim().split(',').map(Number);
assert.ok(Math.abs(policy.upperDispersion.lowerChiSquareQuantile - rValues[0]) < 1e-12);
assert.ok(Math.abs(policy.upperDispersion.factor - rValues[1]) < 1e-12);
assert.match(source, /CONFIRMATORY_PILOT_UPPER_SD_FACTOR = 1\.3704103976822324/u);
assert.match(source, /evidenceSha256/u);
assert.match(source, /registrationSha256/u);
assert.match(source, /selectionAdmitted: false/u);
assert.match(policy.designUse, /must not influence margins/u);
assert.match(policy.failureRule, /Preserve failed original attempts/u);
assert.match(policy.claimBoundary, /not original evidence verification/u);
validateConfirmatoryPilotReductionQualification(read(new URL(
  '../reports/research/confirmatory-pilot-reduction-qualification-receipt.json',
  import.meta.url)), repoRoot);
console.log('Prospective seven-experiment pilot reducer software-qualified against independent R; no pilot data admitted');
