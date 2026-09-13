import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function validateArtifact(root, artifact) {
  const path = resolve(root, artifact.path);
  const stat = lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `${artifact.path} must not be a symbolic link`);
  assert.equal(stat.size, artifact.bytes, `${artifact.path} byte count changed`);
  assert.equal(sha256(path), artifact.sha256, `${artifact.path} digest changed`);
}

export function validateE02V3ExecutionGateReceipt(receipt) {
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.experimentId, 'E02');
  assert.equal(receipt.attemptVersion, 'v3');
  assert.equal(receipt.stage, 'qualification');
  assert.equal(receipt.classification, 'pre-execution-admission-gate');
  assert.equal(receipt.decision, 'ready');
  assert.equal(receipt.registeredExecutionStarted, false);
  assert.equal(receipt.researchFinding, false);
  assert.equal(receipt.scientificDisposition, 'not-tested');
  assert.equal(receipt.candidate.version, '0.1.119');
  assert.equal(receipt.candidate.commit, 'd1d065bf7b8de63ff0b39eccea07bfa73b420f12');
  assert.equal(receipt.candidate.tree, 'accd908b664c9c1dd4105aaf7aa24c11be117570');
  assert.equal(receipt.candidate.clean, true);

  assert.equal(receipt.registration.hash, 'sha256:d35e6b118e4c811f80b426680a0b2f4b0c9b8da3e59bdc56293e557ef979f248');
  assert.equal(receipt.registration.packetCommit, 'a55d049235b31109da3af1d3b843b389dce46a9e');
  assert.equal(receipt.registration.seedCount, 5);
  assert.equal(receipt.registration.disjointFromV1V2, true);
  assert.equal(receipt.registration.simulatedConfirmations, 3);
  assert.equal(receipt.registration.externalSpend, 0);
  assert.equal(receipt.registration.publicChainTransaction, false);
  assert.equal(receipt.softwareReadiness.passed, true);
  assert.equal(receipt.softwareReadiness.allTurnPaths, true);
  assert.equal(receipt.softwareReadiness.remoteTimeoutQuarantine, true);
  assert.equal(receipt.softwareReadiness.abortOnlyAfterQuarantine, true);

  assert.equal(receipt.fullCheck.testFilesPassed, 154);
  assert.equal(receipt.fullCheck.testsPassed, 1_963);
  assert.equal(receipt.fullCheck.rustTestsPassed, 5);
  assert.equal(receipt.fullCheck.secretScanFiles, 770);
  assert.equal(receipt.fullCheck.dependencyAudit, 'no-known-vulnerabilities');
  assert.equal(receipt.fullCheck.exitStatus, 0);
  assert.equal(receipt.modeR.passed, true);
  assert.equal(receipt.modeR.transportSamples, 6);
  assert.equal(receipt.modeR.sideChannelCategories, 12);
  assert.equal(receipt.modeR.crashSurvival, true);
  assert.equal(receipt.modeR.privateUpdateTracks, 3);
  assert.equal(receipt.modeR.exitStatus, 0);

  assert.equal(receipt.resources.maximumParallelSlots, 1);
  assert.equal(receipt.resources.plannedMaximumWallHoursPerSlot, 10);
  assert.equal(receipt.resources.plannedFiveSlotEvidenceGiB, 3);
  assert.equal(receipt.resources.primaryProcessCpuReservationHours, 20);
  assert.equal(receipt.resources.additionalBuildAndAuditSubprocessAllowanceHours, 2);
  assert.ok(receipt.resources.availableFilesystemBytesAtGate >= receipt.resources.minimumFilesystemBytesAtLaunch);
  assert.equal(receipt.resources.externalSpend, 0);
  assert.equal(receipt.releaseAuditor.sha256, '2a81ee950998c91a14801d7d9adde514b5856aa3ad4f6da594f273bf060f307c');
  assert.equal(receipt.launchChecks.length, 9);
  assert.match(receipt.limitations.rendererBuildAdvisory, /two high-severity/u);
  assert.match(receipt.limitations.resourceProjection, /planning projections/u);
  assert.match(receipt.claimBoundary, /No used seed|no used seed/ui);
}

export function validateE02V3ExecutionGatePortable(root = process.cwd()) {
  const receipt = read(resolve(root, 'reports/research/e02-v3-execution-gate-receipt.json'));
  validateE02V3ExecutionGateReceipt(receipt);
  for (const artifact of [
    receipt.registration.packet,
    receipt.registration.binding,
    receipt.softwareReadiness.receipt,
    receipt.resources.envelope,
  ]) validateArtifact(root, artifact);
  const packet = read(resolve(root, receipt.registration.packet.path));
  const binding = read(resolve(root, receipt.registration.binding.path));
  assert.equal(packet.preRegistrationHash, receipt.registration.hash);
  assert.equal(binding.preRegistrationHash, receipt.registration.hash);
  assert.equal(binding.repositoryRegistration.commit, receipt.registration.packetCommit);
  assert.equal(binding.preRunAnchor.anchorClass, 'simulated');
  assert.equal(binding.preRunAnchor.status, 'confirmed');
  return receipt;
}

export function validateE02V3ExecutionGateLive(root = process.cwd()) {
  const receipt = validateE02V3ExecutionGatePortable(root);
  for (const artifact of [receipt.fullCheck.artifact, receipt.modeR.artifact, receipt.releaseAuditor]) {
    validateArtifact(root, artifact);
  }
  const full = readFileSync(resolve(root, receipt.fullCheck.artifact.path), 'utf8');
  assert.match(full, /Test Files\s+154 passed \(154\)/u);
  assert.match(full, /Tests\s+1963 passed \(1963\)/u);
  assert.match(full, /Secret scan passed for 770 files\./u);
  assert.match(full, /No known vulnerabilities found/u);
  assert.match(full, /Exit status: 0/u);
  const modeR = readFileSync(resolve(root, receipt.modeR.artifact.path), 'utf8');
  assert.match(modeR, /"transportSamples":6/u);
  assert.match(modeR, /"activeSideChannelCategories":12/u);
  assert.match(modeR, /"survivorResponsive":true/u);
  assert.match(modeR, /"track":"hybrid"/u);
  assert.match(modeR, /2 high severity vulnerabilities/u);
  assert.match(modeR, /Exit status: 0/u);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === '--live-evidence'),
  'usage: node scripts/check-e02-v3-execution-gate.mjs [--live-evidence]');
  if (process.argv[2] === '--live-evidence') validateE02V3ExecutionGateLive();
  else validateE02V3ExecutionGatePortable();
  console.log(`E02 v3 execution gate valid (${process.argv[2] === '--live-evidence' ? 'tracked and retained raw evidence' : 'portable tracked evidence'})`);
}
