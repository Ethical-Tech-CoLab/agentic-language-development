import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

function validateArtifact(root, artifact) {
  const path = resolve(root, artifact.path);
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${artifact.path} must not be a symbolic link`);
  assert.equal(stat.size, artifact.bytes, `${artifact.path} byte count changed`);
  assert.equal(sha256(path), artifact.sha256, `${artifact.path} digest changed`);
}

export function validateE02V3ReadinessReceipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.experimentId, 'E02');
  assert.equal(receipt.qualificationVersion, 'v3-readiness-v1');
  assert.equal(receipt.classification, 'pre-registration-software-qualification');
  assert.equal(receipt.passed, true);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.registeredExecution, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.candidate.version, '0.1.115');
  assert.equal(receipt.candidate.commit, '2b87fa4177b50d1d0d939c676249bdb1966e3f71');
  assert.equal(receipt.candidate.tree, '01bc386b0bff8e66d81836b919e3ffc712208a13');

  assert.deepEqual(receipt.deadlineQualification.turnPaths, [
    { role: 'baby-a', method: 'observe' },
    { role: 'baby-a', method: 'act' },
    { role: 'baby-b', method: 'receive' },
    { role: 'baby-b', method: 'act' },
    { role: 'baby-a', method: 'onOutcome' },
  ]);
  assert.equal(receipt.deadlineQualification.syntheticForfeitCases, 5);
  assert.equal(receipt.deadlineQualification.framedRemoteDeadlineCases, 5);
  assert.equal(receipt.deadlineQualification.restartQuarantineCases, 1);
  assert.equal(receipt.deadlineQualification.nonRemoteRejectionStreakCases, 1);
  assert.equal(receipt.deadlineQualification.deadlineMilliseconds, 1_000);
  assert.equal(receipt.deadlineQualification.remoteDisposition, 'immediate-pause-quarantine-abort-only');
  assert.equal(receipt.deadlineQualification.nonRemoteDisposition, 'five-consecutive-rejections-pause');

  assert.equal(receipt.fullCheck.testFilesPassed, 153);
  assert.equal(receipt.fullCheck.testsPassed, 1_959);
  assert.equal(receipt.fullCheck.rustTestsPassed, 5);
  assert.equal(receipt.fullCheck.secretScanFiles, 764);
  assert.equal(receipt.fullCheck.dependencyAudit, 'no-known-vulnerabilities');
  assert.equal(receipt.fullCheck.exitStatus, 0);
  assert.equal(receipt.modeR.distinctLearnerContainers, true);
  assert.equal(receipt.modeR.directNetworkRoutes, 'refused');
  assert.equal(receipt.modeR.timingNormalization, 'normalized');
  assert.equal(receipt.modeR.activeSideChannelCategories, 12);
  assert.equal(receipt.modeR.transportSamples, 6);
  assert.equal(receipt.modeR.timingWithinTolerance, true);
  assert.equal(receipt.modeR.sizeWithinTolerance, true);
  assert.equal(receipt.modeR.errorShapeWithinTolerance, true);
  assert.equal(receipt.modeR.crashSurvivorResponsive, true);
  assert.deepEqual(receipt.modeR.privateUpdateTracks, ['scratch-rl', 'self-supervised', 'hybrid']);
  assert.equal(receipt.modeR.exitStatus, 0);

  assert.equal(receipt.sourceArtifacts.length, 6);
  assert.equal(receipt.limitations.nestedRendererBuildAdvisory.reportedHighSeverity, 2);
  assert.equal(receipt.limitations.nestedRendererBuildAdvisory.runtimeDisposition, 'pruned-before-runtime');
  assert.match(receipt.limitations.faultInjectionTopology, /did not inject/u);
  assert.match(receipt.limitations.researchBoundary, /No registered E02 v3/u);
  assert.match(receipt.claimBoundary, /not E02 completion/u);
}

export function validateE02V3ReadinessPortable(root = process.cwd()) {
  const receipt = read(resolve(root, 'reports/research/e02-v3-readiness-qualification-receipt.json'));
  validateE02V3ReadinessReceipt(receipt);
  return receipt;
}

export function validateE02V3ReadinessLive(root = process.cwd()) {
  const receipt = validateE02V3ReadinessPortable(root);
  for (const artifact of receipt.sourceArtifacts) validateArtifact(root, artifact);
  validateArtifact(root, receipt.fullCheck.artifact);
  validateArtifact(root, receipt.modeR.artifact);

  const fullCheck = readFileSync(resolve(root, receipt.fullCheck.artifact.path), 'utf8');
  assert.match(fullCheck, /Test Files\s+153 passed \(153\)/u);
  assert.match(fullCheck, /Tests\s+1959 passed \(1959\)/u);
  assert.match(fullCheck, /Secret scan passed for 764 files\./u);
  assert.match(fullCheck, /No known vulnerabilities found/u);
  assert.match(fullCheck, /Exit status: 0/u);

  const modeR = readFileSync(resolve(root, receipt.modeR.artifact.path), 'utf8');
  assert.match(modeR, /"mode":"research-grade"/u);
  assert.match(modeR, /"activeSideChannelCategories":12/u);
  assert.match(modeR, /"transportSamples":6/u);
  assert.match(modeR, /"survivorResponsive":true/u);
  for (const track of receipt.modeR.privateUpdateTracks) {
    assert.match(modeR, new RegExp(`"track":"${track}"`, 'u'));
  }
  assert.match(modeR, /2 high severity vulnerabilities/u);
  assert.match(modeR, /Exit status: 0/u);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(
    process.argv.length === 2 ||
      (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
    'usage: node scripts/check-e02-v3-readiness-qualification.mjs [--live-evidence]',
  );
  if (process.argv[2] === '--live-evidence') validateE02V3ReadinessLive();
  else validateE02V3ReadinessPortable();
  console.log(
    `E02 v3 readiness qualification valid (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`,
  );
}
