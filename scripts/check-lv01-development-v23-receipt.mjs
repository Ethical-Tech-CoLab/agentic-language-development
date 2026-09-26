import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Portable summary checks are not a replacement for the retained-evidence audit below.
export function validateLv01DevelopmentV23Receipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.classification, 'lv01-development-topology-authority-receipt');
  assert.equal(receipt.status, 'completed-bounded-development-observation');
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.attempt.runId, 'lv01-development-v23-p0001');
  assert.equal(receipt.attempt.allocation, 'protocols/lv01-development-resource-allocation.v23.json');
  assert.equal(receipt.attempt.evidenceRoot, 'evidence/lv01/development-v23/lv01-development-v23-p0001');
  assert.equal(receipt.attempt.bundleManifestHash,
    'sha256:75bc55e625d1ae4a882d54a2e9ad9223f308136eb245a3f0889f5ec8ef46a28a');
  assert.deepEqual(receipt.attempt.retainedFiles, [
    { path: 'output/lv01-fixture-result.json', sha256: 'sha256:3ea04d8e13f705b5d2d1f45c536f4d4cf182d79ae2aaef716e84a6dd40431385' },
    { path: 'output/offline-verification.json', sha256: 'sha256:9dfa61809acd2c49ee1f1be0b934c486d5042f2e9c9f702913be7c58870666dd' },
    { path: 'output/lv01-authority-observation.json', sha256: 'sha256:ea257975e205b188072492d106f520e463b54d3d0add9acd89f57959d4dc7cd3' },
    { path: 'output/lv01-fixture-resources.json', sha256: 'sha256:9e486a625cbd07ecd03ff802e75eac7ef63c65086d544aa80bc4c6a9d002b178' },
  ]);
  for (const file of receipt.attempt.retainedFiles) {
    assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/u);
  }
  assert.equal(receipt.observed.state, 'sealed');
  assert.equal(receipt.observed.trainingTurns, 64);
  assert.equal(receipt.observed.evaluationTurns, 24);
  assert.equal(receipt.observed.checkpointCount, 12);
  assert.equal(receipt.observed.offlineVerifierExitCode, 0);
  assert.equal(receipt.observed.resourceSamples, 488);
  assert.equal(receipt.observed.nonEmptyResourceSamples, 326);
  assert.ok(receipt.observed.resourceSamples >= receipt.observed.nonEmptyResourceSamples);
  assert.ok(receipt.observed.nonEmptyResourceSamples > 0);
  assert.equal(receipt.observed.serviceCount, 17);
  assert.equal(receipt.observed.deniedPrivateModelAccessProbes, 4);
  assert.deepEqual(receipt.observed.finalVerifiedSizes, {
    'baby-a-ledger': 239,
    'baby-b-ledger': 224,
    channel: 88,
    turns: 88,
    intervention: 1,
  });
  assert.ok(Array.isArray(receipt.observed.verifiedChecks) && receipt.observed.verifiedChecks.length > 0);
  assert.ok(Array.isArray(receipt.limitations) && receipt.limitations.length > 0);
  assert.equal(typeof receipt.claimBoundary, 'string');
  assert.ok(receipt.claimBoundary.length > 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = JSON.parse(readFileSync('reports/research/lv01-development-v23-receipt.json', 'utf8'));
  validateLv01DevelopmentV23Receipt(receipt);

  const evidenceRoot = receipt.attempt.evidenceRoot;
  const sha256 = (path) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

  for (const file of receipt.attempt.retainedFiles) {
    assert.equal(sha256(`${evidenceRoot}/${file.path}`), file.sha256, `${file.path} hash changed`);
  }

  const result = JSON.parse(readFileSync(`${evidenceRoot}/output/lv01-fixture-result.json`, 'utf8'));
  assert.equal(result.runId, receipt.attempt.runId);
  assert.equal(result.state, receipt.observed.state);
  assert.equal(result.trainingTurns, receipt.observed.trainingTurns);
  assert.equal(result.evaluationTurns, receipt.observed.evaluationTurns);
  assert.equal(result.checkpointCount, receipt.observed.checkpointCount);
  assert.equal(result.researchFinding, false);

  const verification = JSON.parse(readFileSync(`${evidenceRoot}/output/offline-verification.json`, 'utf8'));
  assert.equal(verification.runId, receipt.attempt.runId);
  assert.equal(verification.exitCode, receipt.observed.offlineVerifierExitCode);
  assert.equal(verification.bundleManifestHash, receipt.attempt.bundleManifestHash);
  assert.deepEqual(verification.finalVerifiedSizes, {
    'baby-a-ledger': receipt.observed.finalVerifiedSizes['baby-a-ledger'],
    'babyA': receipt.observed.finalVerifiedSizes['baby-a-ledger'],
    'baby-b-ledger': receipt.observed.finalVerifiedSizes['baby-b-ledger'],
    'babyB': receipt.observed.finalVerifiedSizes['baby-b-ledger'],
    channel: receipt.observed.finalVerifiedSizes.channel,
    turns: receipt.observed.finalVerifiedSizes.turns,
    intervention: receipt.observed.finalVerifiedSizes.intervention,
  });

  const resources = JSON.parse(readFileSync(`${evidenceRoot}/output/lv01-fixture-resources.json`, 'utf8'));
  assert.equal(resources.samples.length, receipt.observed.resourceSamples);
  const nonEmpty = resources.samples.filter((sample) => sample.rows?.length > 0).length;
  assert.equal(nonEmpty, receipt.observed.nonEmptyResourceSamples);

  const authority = JSON.parse(readFileSync(`${evidenceRoot}/output/lv01-authority-observation.json`, 'utf8'));
  assert.equal(authority.services.length, receipt.observed.serviceCount);
  assert.equal(authority.deniedPrivateModelAccess.length, receipt.observed.deniedPrivateModelAccessProbes);
  for (const probe of authority.deniedPrivateModelAccess) {
    assert.equal(probe.denied, true);
  }

  console.log('LV01 v23 bounded topology fixture receipt verified against retained local evidence');
}
